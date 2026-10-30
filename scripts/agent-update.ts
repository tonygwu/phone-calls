import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { agentDefinition } from "../src/agent";
import { configSchema } from "../src/config";
import { canonical, digest } from "../src/contracts";

type RecordValue = Record<string, any>;
const record = (value: unknown, label: string): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value as RecordValue;
};
const own = (value: RecordValue, key: string, label: string) => {
  if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key}: missing required field`);
  return value[key];
};
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// Preserve every provider setting in the before fingerprint. Only the historical
// known empty analysis default is equivalent to absence, as in b716216.
export async function agentFingerprint(raw: unknown) {
  const agent = record(raw, "agent");
  const platform = structuredClone(record(own(agent, "platform_settings", "agent"), "platform_settings"));
  const collection = record(own(platform, "data_collection", "platform_settings"), "data_collection");
  for (const item of Object.values(collection)) {
    const field = record(item, "data_collection field");
    if (field.non_sensitive_value === null) delete field.non_sensitive_value;
  }
  return digest(canonical({
    conversation_config: own(agent, "conversation_config", "agent"),
    platform_settings: platform,
    workflow: own(agent, "workflow", "agent"),
    name: own(agent, "name", "agent"),
    // Version identity catches a changed main branch even when values return to
    // their previous content. Telemetry is required rather than defaulted.
    version_id: own(agent, "version_id", "agent"),
    branch_id: own(agent, "branch_id", "agent"),
    main_branch_id: own(agent, "main_branch_id", "agent"),
  }));
}

// Objects are patched recursively; arrays and scalars are exact values. A
// missing field is drift, never silently equivalent to an empty value.
export function configurationDiff(actual: unknown, desired: unknown, path = "agent"): string[] {
  if (desired && typeof desired === "object" && !Array.isArray(desired)) {
    const a = record(actual, path);
    return Object.entries(desired).flatMap(([key, value]) => !Object.hasOwn(a, key)
      ? [`${path}.${key}`] : configurationDiff(a[key], value, `${path}.${key}`));
  }
  return equal(actual, desired) ? [] : [path];
}
export function desiredPatch(actual: unknown, desired: unknown): RecordValue {
  const a = record(actual, "actual"); const d = record(desired, "desired");
  const patch: RecordValue = {};
  for (const [key, value] of Object.entries(d)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = desiredPatch(Object.hasOwn(a, key) ? a[key] : {}, value);
      if (Object.keys(nested).length) patch[key] = nested;
    } else if (!Object.hasOwn(a, key) || !equal(a[key], value)) patch[key] = value;
  }
  return patch;
}
const userSchema = z.object({ user_id: z.string().min(1), workspace_id: z.string().min(1) });
const reviewSchema = z.strictObject({ verdict: z.literal("ship"), planSha256: z.string().regex(/^[a-f0-9]{64}$/) });
const scopeSchema = z.enum(["full", "permission-only"]);
type Scope = z.infer<typeof scopeSchema>;
const planSchema = z.strictObject({
  protocol: z.literal("agent-update-v2"),
  scope: scopeSchema,
  account: userSchema,
  agentId: z.string().min(1),
  serviceConfigSha256: z.string(),
  beforeSha256: z.string(),
  desiredSha256: z.string(),
  patch: z.record(z.string(), z.unknown()),
  changedPaths: z.array(z.string()),
});
type Plan = z.infer<typeof planSchema>;

function desiredConfiguration(scope: Scope, voiceId: string) {
  if (scope === "permission-only") {
    return { platform_settings: { overrides: { conversation_config_override: { agent: { prompt: { prompt: true } } } } } };
  }
  const definition = agentDefinition(voiceId);
  // Resource setup owns webhook tool IDs. Maintenance must preserve installed
  // tools, including connect_owner, even if this checkout predates their setup.
  const { tool_ids: _toolIds, ...prompt } = definition.conversation_config.agent.prompt;
  return { ...definition, conversation_config: { ...definition.conversation_config,
    agent: { ...definition.conversation_config.agent, prompt },
  } };
}

const usage = "Usage: agent-update.ts plan [--permission-only] | apply | readback";
export function parseAgentUpdateArguments(args: string[]): { mode: string; scope?: Scope } {
  const [mode, ...flags] = args;
  if (!["plan", "apply", "readback"].includes(mode)) throw new Error(usage);
  if (!flags.length) return { mode };
  if (mode === "plan" && flags.length === 1 && flags[0] === "--permission-only") return { mode, scope: "permission-only" };
  throw new Error(usage);
}

type Options = { root?: string; fetcher?: typeof fetch; apiKey?: string; log?: (value: unknown) => void; scope?: Scope };
export async function runAgentUpdate(mode: string, options: Options = {}) {
  if (!["plan", "apply", "readback"].includes(mode)) throw new Error(usage);
  if (mode !== "plan" && options.scope !== undefined) throw new Error("Update scope may be selected only when creating a plan; apply/readback use the saved plan scope");
  if (options.scope !== undefined) scopeSchema.parse(options.scope);
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = resolve(root, "private/agent-update");
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const lockPath = resolve(dir, "lock");
  const lock = openSync(lockPath, "wx", 0o600);
  const log = options.log ?? console.log;
  const counts = { attempted: 0, succeeded: 0, failed: 0 };
  const write = (name: string, value: unknown) => {
    const path = resolve(dir, name);
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); chmodSync(path, 0o600);
  };
  const read = (name: string) => JSON.parse(readFileSync(resolve(dir, name), "utf8"));
  let scope: Scope | undefined;
  try {
    const c = configSchema.parse(JSON.parse(readFileSync(resolve(root, "private/service-config.json"), "utf8")));
    // A saved scope is mandatory. Never turn an older or malformed scoped plan
    // into the broader default update during apply or readback.
    const savedPlan = mode === "plan" ? undefined : read("plan.json");
    const savedDefinition = savedPlan === undefined ? undefined : planSchema.parse(savedPlan.plan);
    scope = mode === "plan" ? options.scope ?? "full" : savedDefinition!.scope;
    const desired = desiredConfiguration(scope, c.voiceId);
    const serviceConfigSha256 = await digest(canonical(c));
    const desiredSha256 = await digest(canonical(desired));
    const verifiedScope = scope === "full"
      ? { prompt_matches_repo: true, managed_config_matches_repo: true }
      : { prompt_override_permission_enabled: true, managed_config_matches_plan: true };
    const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY is missing");
    const endpoint = `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(c.elevenAgentId)}`;
    const request = async (label: string, url: string, method: "GET" | "PATCH", body?: unknown) => {
      if ((url !== endpoint && url !== "https://api.elevenlabs.io/v1/user") || (method === "PATCH" && url !== endpoint)) throw new Error("Unapproved maintenance endpoint");
      counts.attempted++;
      try {
        const fetcher = options.fetcher ?? fetch;
        const response = await fetcher(url, { method, headers: { "xi-api-key": apiKey, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const raw = await response.text();
        const path = resolve(dir, `${label}.raw.json`);
        writeFileSync(path, raw, { mode: 0o600 }); chmodSync(path, 0o600);
        if (!response.ok) throw new Error(`provider_http_${response.status}`);
        const result = JSON.parse(raw);
        counts.succeeded++;
        return result;
      } catch (error) {
        counts.failed++;
        throw new Error(`${label}: provider request or JSON failed; inspect private raw evidence`, { cause: error });
      }
    };
    const getAgent = async (label: string) => {
      const agent = record(await request(label, endpoint, "GET"), label);
      if (agent.agent_id !== c.elevenAgentId) throw new Error("Agent identity mismatch");
      if (agent.branch_id !== agent.main_branch_id || typeof agent.branch_id !== "string") throw new Error("Readback must identify the main agent branch");
      await agentFingerprint(agent);
      return agent;
    };
    const journalPath = resolve(dir, "journal.json");
    const saved = existsSync(journalPath) ? read("journal.json") : null;
    if (mode === "plan" && saved?.state === "intent") throw new Error("An earlier PATCH is uncertain; run agent:readback to reconcile before planning another update");
    if (mode === "plan") {
      const account = userSchema.parse(await request("plan-account", "https://api.elevenlabs.io/v1/user", "GET"));
      const before = await getAgent("plan-before");
      const plan: Plan = { protocol: "agent-update-v2", scope, account, agentId: c.elevenAgentId, serviceConfigSha256, beforeSha256: await agentFingerprint(before), desiredSha256, patch: desiredPatch(before, desired), changedPaths: configurationDiff(before, desired) };
      const hash = await digest(canonical(plan));
      write("plan.json", { hash, plan });
      log({ mode, scope, planSha256: hash, changedPaths: plan.changedPaths, ...counts, calls_placed: 0, mutations: 0 });
      return;
    }
    const plan = savedDefinition!;
    const hash = await digest(canonical(plan));
    if (savedPlan.hash !== hash || plan.agentId !== c.elevenAgentId || plan.serviceConfigSha256 !== serviceConfigSha256 || plan.desiredSha256 !== desiredSha256) throw new Error("Plan hash, selected configuration, or repo definition changed; re-plan and review");
    const account = userSchema.parse(await request(`${mode}-account`, "https://api.elevenlabs.io/v1/user", "GET"));
    if (!equal(account, plan.account)) throw new Error("Provider user/workspace identity changed since review");
    if (mode === "readback") {
      const agent = await getAgent("readback-after");
      const differences = configurationDiff(agent, desired);
      if (differences.length) throw new Error(`Live configuration differs: ${differences.join(", ")}`);
      // Reconciliation is read-only externally. A pending PATCH is consumed only
      // when the exact desired configuration and retained controls are observed.
      if (saved?.state === "intent" && saved.planSha256 === hash) {
        await assertPreserved(read("apply-before.raw.json"), agent, desired);
        write("journal.json", { state: "done", scope, planSha256: hash, afterSha256: await agentFingerprint(agent), reconciled: true });
      }
      log({ mode, scope, ...verifiedScope, configSha256: await agentFingerprint(agent), ...counts, calls_placed: 0, mutations: 0 });
      return;
    }
    const review = reviewSchema.parse(JSON.parse(readFileSync(resolve(root, "private/agent-review.json"), "utf8")));
    if (review.planSha256 !== hash) throw new Error("Agent update needs a fresh ship review of this exact plan");
    if (saved?.state === "intent") throw new Error("An earlier PATCH is uncertain; run agent:readback before any repeat");
    if (saved?.state === "done" && saved.planSha256 === hash) throw new Error("This plan was already applied; run agent:readback instead of repeating it");
    const before = await getAgent("apply-before");
    if (await agentFingerprint(before) !== plan.beforeSha256 || !equal(desiredPatch(before, desired), plan.patch)) throw new Error("Live agent drifted since review; re-plan and review before PATCH");
    if (!plan.changedPaths.length) {
      log({ mode, scope, unchanged: true, ...counts, calls_placed: 0, mutations: 0 });
      return;
    }
    write("journal.json", { state: "intent", scope, planSha256: hash });
    const patched = record(await request("apply-response", endpoint, "PATCH", plan.patch), "patch response");
    if (patched.agent_id !== c.elevenAgentId) throw new Error("PATCH returned a different agent");
    const after = await getAgent("apply-after");
    const differences = configurationDiff(after, desired);
    if (differences.length) throw new Error(`Live configuration differs after PATCH: ${differences.join(", ")}`);
    await assertPreserved(before, after, desired);
    const afterSha256 = await agentFingerprint(after);
    write("journal.json", { state: "done", scope, planSha256: hash, afterSha256 });
    log({ mode, scope, ...verifiedScope, beforeSha256: plan.beforeSha256, afterSha256, ...counts, calls_placed: 0, mutations: 1 });
  } catch (error) {
    log({ mode, scope, ...counts, failure_category: "maintenance_or_identity", calls_placed: 0, uncertain_mutation: existsSync(resolve(dir, "journal.json")) && read("journal.json").state === "intent" });
    throw error;
  } finally { closeSync(lock); unlinkSync(lockPath); }
}

// Managed leaf values may change; provider extras, workflow, and webhook routing
// must survive. Ignore only the one historical empty analysis metadata default.
export async function assertPreserved(before: unknown, after: unknown, desired: unknown) {
  const stripManaged = (actual: RecordValue, d: RecordValue): RecordValue => {
    const result = structuredClone(actual);
    for (const [key, value] of Object.entries(d)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = stripManaged(record(own(actual, key, "preserved"), key), value);
        if (Object.keys(nested).length) result[key] = nested; else delete result[key];
      } else delete result[key];
    }
    return result;
  };
  const relevant = (raw: unknown) => {
    const a = record(raw, "preserved agent");
    const platform = structuredClone(record(a.platform_settings, "platform_settings"));
    for (const field of Object.values(record(platform.data_collection, "data_collection"))) {
      const f = record(field, "data_collection field");
      if (f.non_sensitive_value === null) delete f.non_sensitive_value;
    }
    return { name: a.name, conversation_config: a.conversation_config, platform_settings: platform, workflow: a.workflow };
  };
  const a = stripManaged(relevant(before), record(desired, "desired"));
  const b = stripManaged(relevant(after), record(desired, "desired"));
  if (!equal(a, b)) throw new Error("Unmanaged agent settings changed; inspect before/after readbacks and reconcile");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const { mode, scope } = parseAgentUpdateArguments(process.argv.slice(2));
    return runAgentUpdate(mode, { scope });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
