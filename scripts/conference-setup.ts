import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { agentDefinition } from "../src/agent";
import { configSchema, type Config } from "../src/config";
import { canonical } from "../src/contracts";

// Provider contracts: https://elevenlabs.io/docs/api-reference/tools/create
// https://github.com/elevenlabs/elevenlabs-js/blob/main/src/api/types/WebhookToolApiSchemaConfigInput.ts
// https://github.com/elevenlabs/elevenlabs-js/blob/main/src/api/types/ConvAiDynamicVariable.ts
// https://www.twilio.com/docs/usage/api/applications
class SetupError extends Error {}
const PROTOCOL = "owner-conference-setup-v1";
const ROOT = "private/conference-setup";
const cleanId = z.string().regex(/^[A-Za-z0-9_-]+$/);
const appSid = z.string().regex(/^AP[0-9a-fA-F]{32}$/);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const load = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const object = z.record(z.string(), z.unknown());
const agentSchema = z.object({ agent_id: cleanId, conversation_config: z.object({
  agent: z.object({ prompt: z.object({ prompt: z.string(), tool_ids: z.array(cleanId) }).passthrough() }).passthrough(),
  tts: object, asr: object.optional(),
}).passthrough() }).passthrough();
type Agent = z.infer<typeof agentSchema>;
const accountSchema = z.object({ user_id: z.string().min(1), workspace_id: z.string().min(1) });
const toolSchema = z.object({ id: cleanId, tool_config: object });
const journalSchema = z.object({ protocol: z.literal(PROTOCOL), planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  steps: z.record(z.string(), z.object({ state: z.enum(["intent", "done"]), value: z.unknown().optional() })),
  completed: z.boolean(),
});
type Journal = z.infer<typeof journalSchema>;
type Options = { cwd?: string; fetcher?: typeof fetch; env?: NodeJS.ProcessEnv };

function save(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, file); chmodSync(file, 0o600); }
  finally { if (existsSync(temporary)) rmSync(temporary); }
}
function requireEqual(actual: unknown, expected: unknown, message: string) {
  if (canonical(actual) !== canonical(expected)) throw new SetupError(message);
}
function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new SetupError(`Missing ${name}.`);
  return value;
}

/** Each body property has exactly one source: the call ID is never LLM-supplied. */
export function conferenceTools(publicOrigin: string) {
  const shared = {
    type: "webhook", response_timeout_secs: 20, execution_mode: "immediate", follow_redirects: false,
    api_schema: { method: "POST", request_headers: {
      Authorization: { variable_name: "secret__conference_token" },
      "Content-Type": "application/json",
    } },
  };
  const call = { type: "string", dynamic_variable: "call_id" };
  return [
    { ...shared, name: "connect_owner", description: "Call the configured owner and add them to this same conference after a live representative is ready. The assistant stays in the call. A queued request does not prove the owner answered. Do not use on a self call or while only a menu, voicemail or hold recording is present.",
      api_schema: { ...shared.api_schema, url: `${publicOrigin}/webhooks/twilio/inbound?op=owner`,
        request_body_schema: { type: "object", properties: { call_id: call }, required: ["call_id"] } },
    },

  ];
}

/** Replace explicitly managed fields, preserving every other saved setting. */
export function conferenceAgentPatch(live: Agent, managedPrompt: string, toolIds: string[]) {
  const before = agentSchema.parse(live).conversation_config;
  toolIds.forEach(value => cleanId.parse(value));
  return { conversation_config: {
    ...before,
    agent: { ...before.agent, prompt: { ...before.agent.prompt, prompt: managedPrompt,
      tool_ids: [...new Set([...before.agent.prompt.tool_ids, ...toolIds])],
    } },
    asr: { ...before.asr, user_input_audio_format: "ulaw_8000" },
    tts: { ...before.tts, agent_output_audio_format: "ulaw_8000" },
  } };
}

/** Persist intent before a mutation. Unknown results require manual reconciliation. */
export async function once<T>(journal: Journal, name: string, persist: () => void, action: () => Promise<T>): Promise<T> {
  const previous = journal.steps[name];
  if (previous?.state === "done") {
    if (!("value" in previous)) throw new SetupError("Completed setup step lacks its recorded response.");
    return previous.value as T;
  }
  if (previous) throw new SetupError(`Setup step ${name} has an uncertain result. Reconcile it before another mutation.`);
  journal.steps[name] = { state: "intent" }; persist();
  const value = await action();
  journal.steps[name] = { state: "done", value }; persist();
  return value;
}

export async function runConferenceSetup(mode: string, options: Options = {}) {
  const lock = resolve(options.cwd ?? process.cwd(), ROOT, "execution.lock");
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SetupError("Conference setup has an existing execution lock. Inspect its owner and journal before resuming.");
    throw error;
  }
  try {
    save(resolve(lock, "owner.json"), { pid: process.pid, mode });
    return await executeConferenceSetup(mode, options);
  } finally { rmSync(lock, { recursive: true }); }
}

async function executeConferenceSetup(mode: string, options: Options) {
  if (mode !== "prepare" && mode !== "apply") throw new SetupError("Usage: conference-setup.ts prepare|apply.");
  const cwd = options.cwd ?? process.cwd(), env = options.env ?? process.env, fetcher = options.fetcher ?? fetch;
  const path = (file: string) => resolve(cwd, file);
  const planFile = path(`${ROOT}/plan.json`), journalFile = path(`${ROOT}/journal.json`);
  const configFile = path("private/service-config.json"), secretsFile = path("private/worker-secrets.json");
  const currentConfig = configSchema.parse(load(configFile));
  const currentSecrets = z.record(z.string(), z.string()).parse(load(secretsFile));
  const twilioSid = required(env, "TWILIO_ACCOUNT_SID");
  if (twilioSid !== currentConfig.twilioAccountSid) throw new SetupError("Selected Twilio account differs from the service configuration.");
  const headers = {
    eleven: { "xi-api-key": required(env, "ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
    twilio: { Authorization: `Basic ${Buffer.from(`${twilioSid}:${required(env, "TWILIO_AUTH_TOKEN")}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
  };
  const scriptSha256 = fileHash(fileURLToPath(import.meta.url));
  const agentSourceSha256 = fileHash(path("src/agent.ts"));
  const api = {
    account: `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}.json`,
    applications: `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Applications.json`,
    agent: `https://api.elevenlabs.io/v1/convai/agents/${cleanId.parse(currentConfig.elevenAgentId)}`,
    user: "https://api.elevenlabs.io/v1/user", tools: "https://api.elevenlabs.io/v1/convai/tools",
  };
  async function request(url: string, kind: "eleven" | "twilio", method: "GET" | "POST" | "PATCH", label: string, body?: unknown) {
    let response: Response;
    try { response = await fetcher(url, { method, headers: headers[kind], redirect: "error", signal: AbortSignal.timeout(20_000),
      ...(body === undefined ? {} : { body: kind === "twilio" ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body) }),
    }); } catch { throw new SetupError("Setup provider transport failed. Inspect the journal before retrying a mutation."); }
    const raw = await response.text();
    const rawFile = path(`${ROOT}/raw/${label}-${randomUUID()}.json`);
    mkdirSync(dirname(rawFile), { recursive: true, mode: 0o700 });
    writeFileSync(rawFile, raw, { mode: 0o600, flag: "wx" });
    save(`${rawFile}.http.json`, { url, method, status: response.status, sha256: createHash("sha256").update(raw).digest("hex") });
    if (!response.ok) throw new SetupError(`Setup provider returned HTTP ${response.status}. Inspect the private raw response and journal before retrying.`);
    try { return JSON.parse(raw); } catch { throw new SetupError("Setup provider returned invalid JSON. Inspect the private raw response and journal before retrying."); }
  }
  async function identities() {
    const account = z.object({ sid: z.literal(twilioSid), status: z.literal("active") }).parse(await request(api.account, "twilio", "GET", "twilio-account"));
    const eleven = accountSchema.parse(await request(api.user, "eleven", "GET", "eleven-account"));
    return { twilio: account.sid, eleven };
  }
  async function agent() {
    const saved = agentSchema.parse(await request(api.agent, "eleven", "GET", "agent"));
    if (saved.agent_id !== currentConfig.elevenAgentId) throw new SetupError("Saved ElevenLabs agent identity mismatch.");
    return saved;
  }
  function validateApp(value: unknown, config: Config) {
    return z.object({ sid: appSid, account_sid: z.literal(config.twilioAccountSid),
      voice_url: z.literal(`${config.publicOrigin}/webhooks/twilio/inbound?op=assistant`), voice_method: z.literal("POST"),
      public_application_connect_enabled: z.literal(false),
    }).passthrough().parse(value);
  }
  if (mode === "prepare") {
    if (existsSync(journalFile)) throw new SetupError("A conference setup journal already exists. Inspect it instead of preparing duplicate resources.");
    if ("twilioApplicationSid" in currentConfig) throw new SetupError("Conference resources are already configured. Do not create another application.");
    requireEqual(JSON.parse(currentSecrets.SERVICE_CONFIG), currentConfig, "Local configuration and Worker secret configuration disagree.");
    const selected = await identities(), baseline = await agent();
    const prompt = agentDefinition(currentConfig.voiceId).conversation_config.agent.prompt.prompt;
    const toolConfigs = conferenceTools(currentConfig.publicOrigin);
    const patchTemplate = conferenceAgentPatch(baseline, prompt, ["created_owner_tool"]);
    const plan = {
      protocol: PROTOCOL, identities: selected, serviceConfig: currentConfig, serviceConfigSha256: hash(currentConfig),
      workerSecretsSha256: hash(currentSecrets), serviceConfigSecretBefore: currentSecrets.SERVICE_CONFIG, scriptSha256, agentSourceSha256,
      agentBefore: baseline, agentBeforeSha256: hash(baseline.conversation_config),
      mutations: {
        application: { url: api.applications, method: "POST", body: { FriendlyName: "Private phone assistant conference", VoiceUrl: `${currentConfig.publicOrigin}/webhooks/twilio/inbound?op=assistant`, VoiceMethod: "POST", PublicApplicationConnectEnabled: "false" } },
        ownerTool: { url: api.tools, method: "POST", body: { tool_config: toolConfigs[0] } },
        agent: { url: api.agent, method: "PATCH", body: patchTemplate,
          substitutions: { created_owner_tool: "The ID from the ownerTool creation response" } },
      },
      localOutputs: ["Add created application SID as twilioApplicationSid in private/service-config.json", "Update only SERVICE_CONFIG in private/worker-secrets.json"],
      activation: "FIRST deploy the compatible Worker source with the existing configuration so ordinary calls supply owner_join and the disabled tool header. Verify the deployment before approving apply. Apply then changes the saved agent and local configuration. Deploy the new application SID configuration afterward to enable conferences. Setup never calls a dial endpoint.",
      rollback: { agent: { conversation_config: baseline.conversation_config }, serviceConfig: currentConfig,
        instruction: "Review rollback separately. Do not delete resources that may have active calls. Preserve the prior Worker build and private secrets." },
    };
    const planSha256 = hash(plan); save(planFile, { planSha256, plan });
    return { prepared: `${ROOT}/plan.json`, planSha256, externalChanges: 0, realPhoneCalls: 0 };
  }
  const prepared = load(planFile);
  const plan = z.object({ protocol: z.literal(PROTOCOL), scriptSha256: z.string(), agentSourceSha256: z.string(),
    identities: z.unknown(), serviceConfig: configSchema, serviceConfigSha256: z.string(), workerSecretsSha256: z.string(), serviceConfigSecretBefore: z.string(),
    agentBefore: agentSchema, agentBeforeSha256: z.string(), mutations: z.object({ application: z.object({ body: z.record(z.string(), z.string()) }), ownerTool: z.object({ body: object }), agent: z.object({ body: object }) }),
  }).passthrough().parse(prepared.plan);
  if (prepared.planSha256 !== hash(prepared.plan)) throw new SetupError("Conference setup plan hash mismatch.");
  const planSha256 = prepared.planSha256;
  z.object({ verdict: z.literal("ship"), planSha256: z.literal(planSha256), compatibleWorkerDeployed: z.literal(true) }).parse(load(path(`${ROOT}/review.json`)));
  if (plan.scriptSha256 !== scriptSha256 || plan.agentSourceSha256 !== agentSourceSha256) throw new SetupError("Setup source changed after review. Prepare and review the changed execution plan.");
  const journal: Journal = existsSync(journalFile) ? journalSchema.parse(load(journalFile)) : { protocol: PROTOCOL, planSha256, steps: {}, completed: false };
  if (journal.planSha256 !== planSha256) throw new SetupError("Setup journal belongs to a different plan.");
  const persist = () => save(journalFile, journal);
  // Refuse an unknown mutation before any other API operation on a resumed apply.
  if (Object.values(journal.steps).some(step => step.state === "intent")) throw new SetupError("An earlier setup mutation is uncertain. Reconcile the journal before resuming.");
  const recordedApp = journal.steps.application?.value;
  const completedConfig = recordedApp === undefined ? undefined : { ...plan.serviceConfig, twilioApplicationSid: validateApp(recordedApp, plan.serviceConfig).sid };
  if (hash(currentConfig) !== plan.serviceConfigSha256 && (completedConfig === undefined || hash(currentConfig) !== hash(completedConfig))) throw new SetupError("Service configuration changed after review.");
  // Only our known SERVICE_CONFIG edit can differ during recovery of local writes.
  if (hash(currentSecrets) !== plan.workerSecretsSha256) {
    const originalSecrets = { ...currentSecrets, SERVICE_CONFIG: plan.serviceConfigSecretBefore };
    if (hash(originalSecrets) !== plan.workerSecretsSha256 || completedConfig === undefined) throw new SetupError("Worker secrets changed after review.");
    requireEqual(JSON.parse(currentSecrets.SERVICE_CONFIG), completedConfig, "Worker secret configuration has an unrelated edit.");
  }
  requireEqual(await identities(), plan.identities, "Provider account identity changed after review.");
  if (journal.completed) return { configured: true, alreadyApplied: true, planSha256, realPhoneCalls: 0, deployed: false };
  const live = await agent();
  if (!journal.steps.agent) requireEqual(hash(live.conversation_config), plan.agentBeforeSha256, "Saved agent changed after review.");
  const application = validateApp(await once(journal, "application", persist, async () => validateApp(await request(api.applications, "twilio", "POST", "create-application", plan.mutations.application.body), plan.serviceConfig)), plan.serviceConfig);
  async function createTool(name: "ownerTool") {
    const expected = plan.mutations[name].body.tool_config;
    const created = toolSchema.parse(await once(journal, name, persist, async () => {
      const response = toolSchema.parse(await request(api.tools, "eleven", "POST", `create-${name}`, plan.mutations[name].body));
      // Preserve provider defaults while requiring every requested field to survive.
      assertContains(response.tool_config, expected); return response;
    }));
    assertContains(created.tool_config, expected);
    const readback = toolSchema.parse(await request(`${api.tools}/${created.id}`, "eleven", "GET", `readback-${name}`));
    if (readback.id !== created.id) throw new SetupError("Created tool readback identity mismatch.");
    assertContains(readback.tool_config, expected);
    return created.id;
  }
  const ownerToolId = await createTool("ownerTool");
  const applicationReadback = validateApp(await request(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Applications/${application.sid}.json`, "twilio", "GET", "readback-application"), plan.serviceConfig);
  if (applicationReadback.sid !== application.sid) throw new SetupError("Created application readback identity mismatch.");
  const patchTemplate = plan.mutations.agent.body as ReturnType<typeof conferenceAgentPatch>;
  const patch = conferenceAgentPatch(plan.agentBefore, patchTemplate.conversation_config.agent.prompt.prompt, [ownerToolId]);
  await once(journal, "agent", persist, async () => {
    requireEqual(hash((await agent()).conversation_config), plan.agentBeforeSha256, "Saved agent changed before update. Preserve the owner's edits and review again.");
    const response = agentSchema.parse(await request(api.agent, "eleven", "PATCH", "update-agent", patch));
    if (response.agent_id !== plan.serviceConfig.elevenAgentId) throw new SetupError("Updated agent identity mismatch.");
    assertContains(response.conversation_config, patch.conversation_config); return { agent_id: response.agent_id };
  });
  const updated = await agent(); assertContains(updated.conversation_config, patch.conversation_config);
  const newConfig = { ...plan.serviceConfig, twilioApplicationSid: application.sid };
  const newSecrets = { ...currentSecrets, SERVICE_CONFIG: JSON.stringify(newConfig) };
  save(configFile, newConfig); save(secretsFile, newSecrets);
  journal.completed = true; persist();
  return { configured: true, planSha256, applicationSid: application.sid, toolIds: [ownerToolId], realPhoneCalls: 0, deployed: false };
}

/** Require exact requested scalars and arrays while allowing added provider defaults. */
export function assertContains(actual: unknown, expected: unknown): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new SetupError("Provider readback changed a requested array.");
    expected.forEach((value, index) => assertContains(actual[index], value)); return;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) throw new SetupError("Provider readback changed a requested object.");
    for (const [key, value] of Object.entries(expected)) assertContains((actual as Record<string, unknown>)[key], value);
    return;
  }
  if (actual !== expected) throw new SetupError("Provider readback changed a requested setting.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runConferenceSetup(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error instanceof SetupError ? error.message : "Conference setup configuration or provider response is invalid. Inspect the private plan, journal and raw responses; reconcile uncertain mutations before retrying.");
    process.exitCode = 1;
  });
}
