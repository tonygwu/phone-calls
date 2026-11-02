import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { AGENT_PROMPT } from "../src/agent";
import { configSchema } from "../src/config";
import { canonical } from "../src/contracts";
import { agentFingerprint } from "./agent-update";
import { assertContains, conferenceAgentPatch, conferenceTools, once } from "./conference-setup";

const ROOT = "private/conference-sip", PROTOCOL = "owner-conference-sip-v1";
const id = z.string().regex(/^[A-Za-z0-9_-]+$/), object = z.record(z.string(), z.unknown());
const agentSchema = z.object({ agent_id: id, name: z.string(), conversation_config: z.object({ agent: z.object({ prompt: z.object({ prompt: z.string(), tool_ids: z.array(id) }).passthrough() }).passthrough(), tts: object, asr: object.optional() }).passthrough(), platform_settings: object }).passthrough();
const userSchema = z.object({ user_id: z.string().min(1), workspace_id: z.string().min(1) });
const toolSchema = z.object({ id, tool_config: object });
const secretSchema = z.object({ type: z.literal("stored"), secret_id: id, name: z.string() });
const journalSchema = z.object({ protocol: z.literal(PROTOCOL), planSha256: z.string(), steps: z.record(z.string(), z.object({ state: z.enum(["intent", "done"]), value: z.unknown().optional() })), completed: z.boolean() });
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const load = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const same = (a: unknown, b: unknown, message: string) => { if (canonical(a) !== canonical(b)) throw new Error(message); };
function save(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { renameSync(temp, file); chmodSync(file, 0o600); } finally { if (existsSync(temp)) rmSync(temp); }
}
function sources() {
  return Object.fromEntries(["./conference-sip.ts", "./conference-setup.ts", "./agent-update.ts", "../src/agent.ts", "../src/config.ts", "../src/contracts.ts", "../package-lock.json"].map(name => [name, createHash("sha256").update(readFileSync(fileURLToPath(new URL(name, import.meta.url).href))).digest("hex")]));
}
function ownerTool(value: unknown, origin: string) {
  const tool = toolSchema.parse(value), expected = conferenceTools(origin)[0];
  assertContains(tool.tool_config, { type: expected.type, name: expected.name, api_schema: expected.api_schema });
  return tool;
}
/** Preserve the saved model, voice, tools, workflow and post-call routing. */
export function sipAgentPatch(raw: unknown, ownerToolId: string, headerSecretId: string, origin: string, referencedTools: z.infer<typeof toolSchema>[] = []) {
  const live = agentSchema.parse(raw), platform = live.platform_settings;
  const normalized = structuredClone(live), legacy = live.conversation_config.agent.prompt.tools;
  if (legacy !== undefined && legacy !== null) {
    normalized.conversation_config.agent.prompt.tools = z.array(object).parse(legacy).filter(tool => {
      if (tool.type === "system") return true; // The legacy helper verifies built-in definitions.
      if (!referencedTools.some(reference => live.conversation_config.agent.prompt.tool_ids.includes(reference.id) && canonical(reference.tool_config) === canonical(tool))) throw new Error("An inline tool lacks an exact referenced definition. Reconcile it before setup.");
      return false;
    });
  }
  const overrides = platform.overrides === undefined ? {} : object.parse(platform.overrides);
  const workspace = platform.workspace_overrides === undefined ? {} : object.parse(platform.workspace_overrides);
  // Validate the original projections before changing a built-in definition.
  const patch = conferenceAgentPatch(normalized, AGENT_PROMPT, [ownerToolId]);
  const prompt = patch.conversation_config.agent.prompt;
  const builtins = object.parse(object.parse(prompt).built_in_tools);
  const keypad = z.object({ type: z.literal("system"), params: z.object({ system_tool_type: z.literal("play_keypad_touch_tone") }).passthrough() }).passthrough().parse(builtins.play_keypad_touch_tone);
  // Native Twilio ignores this option. SIP activates it, so select audio tones
  // explicitly for the shared conference instead of inheriting the old value.
  return { conversation_config: { ...patch.conversation_config, agent: { ...patch.conversation_config.agent, prompt: { ...prompt, built_in_tools: { ...builtins,
    play_keypad_touch_tone: { ...keypad, params: { ...keypad.params, use_out_of_band_dtmf: false } },
  } } } }, platform_settings: {
    ...platform,
    overrides: { ...overrides, enable_conversation_initiation_client_data_from_webhook: true },
    workspace_overrides: { ...workspace, conversation_initiation_client_data_webhook: { url: origin + "/webhooks/twilio/inbound?op=sip", request_headers: { Authorization: { secret_id: headerSecretId } } } },
  } };
}
function verifyAgent(updated: z.infer<typeof agentSchema>, before: z.infer<typeof agentSchema>, patch: ReturnType<typeof sipAgentPatch>) {
  // The patch contains every prior conversation/platform field plus the exact
  // reviewed changes. Compare those values and the root settings not patched.
  assertContains(updated, patch);
  same(updated.name, before.name, "Saved agent name changed.");
  same(updated.workflow, before.workflow, "Saved agent workflow changed.");
}
type Options = { cwd?: string; fetcher?: typeof fetch };
export async function runConferenceSip(mode: string, options: Options = {}) {
  if (!["prepare", "apply"].includes(mode)) throw new Error("Usage: conference-sip.ts prepare|apply.");
  const cwd = options.cwd ?? process.cwd(), at = (file: string) => resolve(cwd, file), lock = at(ROOT + "/execution.lock");
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try { mkdirSync(lock, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("SIP setup has an execution lock. Inspect its owner and journal before resuming.");
    throw error;
  }
  try { save(resolve(lock, "owner.json"), { pid: process.pid, mode }); return await execute(mode, at, options.fetcher ?? fetch); }
  catch (error) { save(at(ROOT + "/failure.json"), { category: error instanceof z.ZodError ? "configuration_or_provider_schema" : "setup_or_provider_operation", error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { rmSync(lock, { recursive: true }); }
}
async function execute(mode: string, at: (file: string) => string, fetcher: typeof fetch) {
  const configFile = at("private/service-config.json"), secretsFile = at("private/worker-secrets.json");
  const current = configSchema.parse(load(configFile)), secrets = z.record(z.string(), z.string()).parse(load(secretsFile));
  const planFile = at(ROOT + "/plan.json"), journalFile = at(ROOT + "/journal.json");
  const account = `https://api.twilio.com/2010-04-01/Accounts/${current.twilioAccountSid}`;
  const api = "https://api.elevenlabs.io/v1/convai";
  for (const key of ["ELEVENLABS_API_KEY", "TWILIO_AUTH_TOKEN", "SERVICE_CONFIG"]) if (!secrets[key]) throw new Error(`Missing Worker secret ${key}.`);
  const headers = { eleven: { "xi-api-key": secrets.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, twilio: { Authorization: "Basic " + Buffer.from(`${current.twilioAccountSid}:${secrets.TWILIO_AUTH_TOKEN}`).toString("base64") } };
  async function request(name: string, url: string, method = "GET", body?: unknown) {
    const kind = url === account + ".json" ? "twilio" : "eleven";
    if (kind === "eleven" && !url.startsWith(api + "/") && url !== "https://api.elevenlabs.io/v1/user") throw new Error("Unexpected SIP setup endpoint.");
    let response: Response;
    try { response = await fetcher(url, { method, headers: headers[kind], redirect: "error", signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch { throw new Error("SIP setup transport failed. Reconcile any mutation intent before retrying."); }
    const raw = await response.text(), file = at(`${ROOT}/raw/${name}-${randomUUID()}.json`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, raw, { mode: 0o600, flag: "wx" });
    save(file + ".http.json", { url, method, status: response.status });
    if (!response.ok) throw new Error(`SIP setup HTTP${response.status}. Inspect the private response and reconcile the journal before retrying.`);
    try { return JSON.parse(raw); } catch { throw new Error("SIP setup returned invalid JSON. Inspect the private response and journal."); }
  }
  async function identities() {
    const twilio = z.object({ sid: z.literal(current.twilioAccountSid), status: z.literal("active") }).parse(await request("account", account + ".json"));
    return { twilio: twilio.sid, eleven: userSchema.parse(await request("user", "https://api.elevenlabs.io/v1/user")) };
  }
  async function agent() {
    const value = agentSchema.parse(await request("agent", api + "/agents/" + id.parse(current.elevenAgentId)));
    if (value.agent_id !== current.elevenAgentId) throw new Error("Managed agent identity mismatch.");
    return value;
  }
  if (mode === "prepare") {
    if (existsSync(journalFile)) throw new Error("A SIP setup journal exists. Reconcile it instead of creating another plan.");
    if (current.conferenceSip) throw new Error("SIP routing is already configured. Do not create another route.");
    same(JSON.parse(secrets.SERVICE_CONFIG), current, "Worker secret and local service configuration disagree.");
    const selected = await identities(), before = await agent();
    const phones = z.array(z.object({ provider: z.string(), assigned_agent: z.object({ agent_id: id }).nullable() }).passthrough()).parse(await request("phones", api + "/phone-numbers"));
    if (phones.some(phone => phone.provider === "sip_trunk" && phone.assigned_agent?.agent_id === current.elevenAgentId)) throw new Error("An existing SIP route targets this agent. Reconcile it before provisioning.");
    const existing = [], referencedTools = [];
    for (const toolId of before.conversation_config.agent.prompt.tool_ids) {
      const tool = toolSchema.parse(await request("tool", api + "/tools/" + toolId));
      if (tool.id !== toolId) throw new Error("Saved tool identity mismatch.");
      referencedTools.push(tool);
      if (tool.tool_config.name === "connect_owner") existing.push(ownerTool(tool, current.publicOrigin));
    }
    if (existing.length > 1) throw new Error("Multiple owner tools are installed. Reconcile them before setup.");
    const tag = randomUUID().replaceAll("-", "").slice(0, 12), identifier = "assistant-" + tag;
    const password = randomBytes(32).toString("hex"), initiationSecret = randomBytes(32).toString("hex");
    const plan = { protocol: PROTOCOL, identities: selected, sourceSha256: sources(), configBefore: current, secretsBefore: secrets,
      agentBefore: before, agentBeforeSha256: await agentFingerprint(before), existingOwnerTool: existing[0] ?? null, referencedTools,
      identifier, username: identifier, sipPassword: password, initiationSecret,
      mutations: {
        headerSecret: { url: api + "/secrets", method: "POST", body: { type: "new", name: "SIP initialization " + tag, value: "Bearer " + initiationSecret } },
        route: { url: api + "/phone-numbers", method: "POST", body: { provider: "sip_trunk", phone_number: identifier, label: "Private assistant conference " + tag, agent_id: current.elevenAgentId, inbound_trunk_config: { media_encryption: "required", credentials: { username: identifier, password } } } },
        ownerTool: existing.length ? null : { url: api + "/tools", method: "POST", body: { tool_config: conferenceTools(current.publicOrigin)[0] } },
        agent: { url: api + "/agents/" + current.elevenAgentId, method: "PATCH", body: sipAgentPatch(before, existing[0]?.id ?? "created_owner_tool", "created_header_secret", current.publicOrigin, referencedTools) },
      },
      activation: "No calls or deployment. Existing ordinary and App registration requests already supply initiation data. SIP is enabled in the Worker only by a later separately reviewed deployment of the resulting local configuration and secrets.",
      rollback: "Review separately after stopping active conferences. Restore the saved agent and configuration, preserve existing App resources and call history, and do not delete resources used by an active deployment.",
    };
    const planSha256 = hash(plan); save(planFile, { planSha256, plan });
    return { prepared: ROOT + "/plan.json", planSha256, externalChanges: 0, realPhoneCalls: 0, createsOwnerTool: existing.length === 0 };
  }
  const prepared = load(planFile), plan = z.object({ protocol: z.literal(PROTOCOL), sourceSha256: z.record(z.string(), z.string()), configBefore: configSchema, secretsBefore: z.record(z.string(), z.string()), agentBefore: agentSchema, agentBeforeSha256: z.string(), identifier: id, username: id, sipPassword: z.string().min(32), initiationSecret: z.string().min(32), existingOwnerTool: toolSchema.nullable(), referencedTools: z.array(toolSchema), mutations: z.object({ headerSecret: z.object({ body: object }), route: z.object({ body: object }), ownerTool: z.object({ body: object }).nullable(), agent: z.object({ body: object }) }) }).passthrough().parse(prepared.plan);
  if (hash(prepared.plan) !== prepared.planSha256) throw new Error("SIP plan hash mismatch.");
  const planSha256 = prepared.planSha256;
  z.object({ verdict: z.literal("ship"), planSha256: z.literal(planSha256) }).parse(load(at(ROOT + "/review.json")));
  same(sources(), plan.sourceSha256, "SIP setup source changed after review.");
  same(plan.referencedTools.map(tool => tool.id), plan.agentBefore.conversation_config.agent.prompt.tool_ids, "Reviewed referenced tool identities are incomplete.");
  same(plan.mutations.agent.body, sipAgentPatch(plan.agentBefore, plan.existingOwnerTool?.id ?? "created_owner_tool", "created_header_secret", current.publicOrigin, plan.referencedTools), "Reviewed agent patch differs from the execution template.");
  assertContains(plan.mutations.route.body, { provider: "sip_trunk", phone_number: plan.identifier, agent_id: plan.configBefore.elevenAgentId, inbound_trunk_config: { media_encryption: "required", credentials: { username: plan.username, password: plan.sipPassword } } });
  if (Object.hasOwn(plan.mutations.route.body, "outbound_trunk_config")) throw new Error("SIP setup only permits an inbound route.");
  assertContains(plan.mutations.headerSecret.body, { type: "new", value: "Bearer " + plan.initiationSecret });
  const journal = existsSync(journalFile) ? journalSchema.parse(load(journalFile)) : { protocol: PROTOCOL, planSha256, steps: {}, completed: false } as z.infer<typeof journalSchema>;
  if (journal.planSha256 !== planSha256) throw new Error("SIP journal belongs to another plan.");
  if (Object.values(journal.steps).some(step => step.state === "intent")) throw new Error("An earlier SIP mutation is uncertain. Reconcile before resuming.");
  const persist = () => save(journalFile, journal);
  const configured = (phoneId: string) => ({ ...plan.configBefore, conferenceSip: { identifier: plan.identifier, username: plan.username, phoneId } });
  const routeValue = journal.steps.route?.value as { phone_number_id: string } | undefined;
  const completedConfig = routeValue ? configured(routeValue.phone_number_id) : undefined;
  const completedSecrets = completedConfig ? { ...plan.secretsBefore, SERVICE_CONFIG: JSON.stringify(completedConfig), ELEVENLABS_SIP_PASSWORD: plan.sipPassword, ELEVENLABS_INITIATION_SECRET: plan.initiationSecret } : undefined;
  if (hash(current) !== hash(plan.configBefore) && (!completedConfig || hash(current) !== hash(completedConfig))) throw new Error("Local configuration changed after review.");
  if (hash(secrets) !== hash(plan.secretsBefore) && (!completedSecrets || hash(secrets) !== hash(completedSecrets))) throw new Error("Worker secrets changed after review.");
  same(await identities(), plan.identities, "Selected provider account changed after review.");
  const live = await agent();
  if (!journal.steps.agent) same(await agentFingerprint(live), plan.agentBeforeSha256, "Saved agent changed after review.");
  for (const reference of plan.referencedTools) {
    const installed = toolSchema.parse(await request("tool-before-mutations", api + "/tools/" + reference.id));
    same(installed, reference, "Installed tool changed after review.");
  }
  const headerSecret = secretSchema.parse(await once(journal, "headerSecret", persist, async () => secretSchema.parse(await request("create-secret", api + "/secrets", "POST", plan.mutations.headerSecret.body))));
  if (headerSecret.name !== plan.mutations.headerSecret.body.name) throw new Error("Created header secret identity mismatch.");
  const secretList = z.object({ secrets: z.array(secretSchema), next_cursor: z.string().nullable() }).parse(await request("read-secret", api + "/secrets?search=" + encodeURIComponent(headerSecret.name)));
  if (secretList.next_cursor !== null || secretList.secrets.filter(secret => secret.secret_id === headerSecret.secret_id && secret.name === headerSecret.name).length !== 1) throw new Error("Header secret readback is ambiguous or incomplete.");
  const routeCreated = z.object({ phone_number_id: id }).parse(await once(journal, "route", persist, async () => z.object({ phone_number_id: id }).parse(await request("create-route", api + "/phone-numbers", "POST", plan.mutations.route.body))));
  const route = z.object({ phone_number_id: z.literal(routeCreated.phone_number_id), provider: z.literal("sip_trunk"), phone_number: z.literal(plan.identifier), assigned_agent: z.object({ agent_id: z.literal(current.elevenAgentId) }), supports_inbound: z.literal(true), supports_outbound: z.literal(false), inbound_trunk: z.object({ media_encryption: z.literal("required"), has_auth_credentials: z.literal(true), username: z.literal(plan.username) }) }).parse(await request("read-route", api + "/phone-numbers/" + routeCreated.phone_number_id));
  let toolId: string;
  if (plan.existingOwnerTool) {
    const currentTool = ownerTool(await request("read-owner-tool", api + "/tools/" + plan.existingOwnerTool.id), current.publicOrigin);
    same(currentTool, plan.existingOwnerTool, "Installed owner tool changed after review."); toolId = currentTool.id;
  } else {
    const created = ownerTool(await once(journal, "ownerTool", persist, async () => ownerTool(await request("create-owner-tool", api + "/tools", "POST", plan.mutations.ownerTool!.body), current.publicOrigin)), current.publicOrigin);
    const saved = ownerTool(await request("read-owner-tool", api + "/tools/" + created.id), current.publicOrigin);
    if (saved.id !== created.id) throw new Error("Owner tool readback identity mismatch."); toolId = saved.id;
  }
  const patch = sipAgentPatch(plan.agentBefore, toolId, headerSecret.secret_id, current.publicOrigin, plan.referencedTools);
  await once(journal, "agent", persist, async () => {
    same(await agentFingerprint(await agent()), plan.agentBeforeSha256, "Saved agent changed before patch.");
    const updated = agentSchema.parse(await request("update-agent", api + "/agents/" + current.elevenAgentId, "PATCH", patch));
    if (updated.agent_id !== current.elevenAgentId) throw new Error("Updated agent identity mismatch.");
    verifyAgent(updated, plan.agentBefore, patch); return { agent_id: updated.agent_id };
  });
  const updated = await agent(); verifyAgent(updated, plan.agentBefore, patch);
  const nextConfig = configured(route.phone_number_id);
  save(configFile, nextConfig); save(secretsFile, { ...plan.secretsBefore, SERVICE_CONFIG: JSON.stringify(nextConfig), ELEVENLABS_SIP_PASSWORD: plan.sipPassword, ELEVENLABS_INITIATION_SECRET: plan.initiationSecret });
  journal.completed = true; persist();
  return { configured: true, planSha256, routeId: route.phone_number_id, toolId, realPhoneCalls: 0, deployed: false };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runConferenceSip(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error("SIP setup failed. Inspect its private plan, raw responses and journal. Reconcile uncertain mutations before retrying; never repeat a call."); process.exitCode = 1;
  });
}
