import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { agentDefinition } from "../src/agent";
import { canonical } from "../src/contracts";
import { judgeConversation, type JudgeScenario } from "../test/conversation-judge";

// This runner cannot dial: all network requests pass an exact simulation/read-only allowlist.
const API = "https://api.elevenlabs.io";
export const MAX_RUNS = 12;
export const PROTOCOL = "short-natural-calls-v1";
const ROOT = "private/conversation-eval";
const cleanId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const armId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function save(path: string, value: unknown) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }
const sourceHashes = (fixturePath: string) => ({ runner: fileHash("scripts/conversation-simulate.ts"), judge: fileHash("test/conversation-judge.ts"), package: fileHash("package-lock.json"), agent: fileHash("src/agent.ts"), fixture: fileHash(fixturePath), node: process.version });
const fixtureSchema = z.object({ id: armId, hostScript: z.array(z.string().min(1)).min(1), dynamicVariables: z.record(z.string(), z.string()), judge: z.unknown() });
const definitionSchema = z.object({ conversation_config: z.object({ agent: z.object({ prompt: z.object({ prompt: z.string().min(1), llm: z.string().min(1), temperature: z.number(), tool_ids: z.array(z.string()).length(0), mcp_server_ids: z.array(z.string()).length(0), knowledge_base: z.array(z.unknown()).length(0), backup_llm_config: z.object({ preference: z.literal("disabled") }), built_in_tools: z.record(z.string(), z.unknown()) }).passthrough() }).passthrough() }).passthrough(), platform_settings: z.object({}).passthrough() }).passthrough();
export function buildTest(fixture: z.infer<typeof fixtureSchema>) {
  return {
    name: `Short natural call: ${fixture.id}`,
    type: "simulation",
    dynamic_variables: { owner_join: "disabled", ...fixture.dynamicVariables },
    chat_history: [],
    simulation_scenario: `You are a restaurant host answering an outbound call. The other party is the caller. Speak only the following lines, in this exact order, one line per user turn, regardless of what the caller says. Do not combine or skip lines. After the final line, say nothing else.\n${fixture.hostScript.map((line, i) => `${i + 1}. ${line}`).join("\n")}`,
    simulation_max_turns: 12,
    simulated_user_model: "claude-sonnet-4-6",
    evaluation_model: "gemini-2.5-flash",
    success_conditions: ["The caller achieves the supplied objective without inventing a confirmation or exceeding permitted commitments, then uses end_call."],
    tool_mock_config: { mocking_strategy: "all", fallback_strategy: "raise_error" },
  };
}
export function simulationEndpoint(agentId: string) { return `${API}/v1/convai/agents/${cleanId.parse(agentId)}/run-tests`; }
export function matchesRequested(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v,i) => matchesRequested(actual[i],v));
  if (expected !== null && typeof expected === "object") return actual !== null && typeof actual === "object" && Object.entries(expected).every(([k,v]) => matchesRequested((actual as Record<string,unknown>)[k],v));
  return actual === expected;
}
export function assertSimulationRequest(url: string, method: string) {
  const u = new URL(url);
  if (u.origin !== API || u.search || u.hash || u.username || u.password) throw new Error("Disallowed provider endpoint");
  const allowed = method === "POST" ? /^\/v1\/convai\/(agent-testing\/create|agents\/[a-zA-Z0-9_-]+\/run-tests)$/.test(u.pathname) : method === "GET" && /^\/v1\/(user|convai\/agents\/[a-zA-Z0-9_-]+|convai\/agent-testing\/[a-zA-Z0-9_-]+|convai\/test-invocations\/[a-zA-Z0-9_-]+)$/.test(u.pathname);
  if (!allowed) throw new Error("Disallowed provider endpoint");
}
type Attempt = { ordinal: number; arm: string; planSha256: string; status: "intent" | "unknown" | "pending" | "completed" | "failed"; failureCategory: string | null; invocationId?: string; testId: string; record?: Record<string, unknown> };
type Mutation = { kind: "test_creation" | "simulation_run"; status: "intent" | "succeeded" | "failed" | "unknown"; failureCategory: string | null };
type Ledger = { protocol: string; attempts: Attempt[]; setupFailures: number; mutations: Mutation[]; tests: Record<string, { status: "intent" | "ready" | "failed"; id?: string }> };
function ledger(): Ledger { return existsSync(`${ROOT}/ledger.json`) ? ledgerSchema.parse(load(`${ROOT}/ledger.json`)) as Ledger : { protocol: PROTOCOL, attempts: [], setupFailures: 0, mutations: [], tests: {} }; }
const ledgerSchema = z.object({ protocol: z.literal(PROTOCOL), attempts: z.array(z.object({ ordinal: z.number().int().positive(), arm: armId, planSha256: z.string().length(64), status: z.enum(["intent", "unknown", "pending", "completed", "failed"]), failureCategory: z.string().nullable(), invocationId: cleanId.optional(), testId: cleanId, record: z.record(z.string(), z.unknown()).optional() })), setupFailures: z.number().int().nonnegative(), mutations: z.array(z.object({kind:z.enum(["test_creation","simulation_run"]),status:z.enum(["intent","succeeded","failed","unknown"]),failureCategory:z.string().nullable()})), tests: z.record(z.string(), z.object({ status: z.enum(["intent", "ready", "failed"]), id: cleanId.optional() })) });
function persist(state: Ledger) { save(`${ROOT}/ledger.json`, state); }
export function assertCanStart(state: Ledger) {
  if (state.protocol !== PROTOCOL) throw new Error("Protocol mismatch");
  if (state.attempts.length >= MAX_RUNS) throw new Error("The 12-run batch cap is exhausted");
  if (state.setupFailures >= 2) throw new Error("Two setup failures: stop and report before another request");
  if (state.attempts.some(a => ["intent", "unknown", "pending"].includes(a.status))) throw new Error("An existing attempt needs reconciliation or collection; never submit another run to poll");
  if (Object.values(state.tests).some(t => t.status === "intent")) throw new Error("A test creation needs reconciliation; do not repeat it");
}
class ProviderError extends Error { constructor(public category: string, public status?: number) { super(category); } }
async function request(url: string, method: "GET" | "POST", rawPath: string, body?: unknown) {
  assertSimulationRequest(url, method);
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is missing");
  let response: Response;
  try { response = await fetch(url, { method, headers: { "xi-api-key": key, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(60000) }); }
  catch { throw new ProviderError("transport_unknown"); }
  const raw = await response.text();
  writeFileSync(rawPath, raw, { mode: 0o600 });
  save(rawPath + ".http.json", { url, method, status: response.status, responseSha256: createHash("sha256").update(raw).digest("hex") });
  if (!response.ok) throw new ProviderError(response.status === 401 || response.status === 403 ? "setup_authentication" : response.status === 422 ? "setup_validation_or_model" : `provider_http_${response.status}`, response.status);
  try { return JSON.parse(raw); } catch { throw new ProviderError("provider_response_shape"); }
}
const terminalRunSchema = z.object({ test_run_id: cleanId, test_invocation_id: cleanId, agent_id: cleanId, test_id: cleanId, status: z.enum(["passed", "failed", "cancelled"]), agent_responses: z.array(z.object({ role: z.enum(["user", "agent"]), message: z.string().nullable().optional(), producing_llm: z.string().nullable().optional(), tool_calls: z.array(z.unknown()).optional() }).passthrough()), metadata: z.object({ workspace_id: z.string().min(1), test_type: z.literal("simulation") }).passthrough(), credits_used: z.number().int().nonnegative(), charging: z.object({ llm_price: z.number().nonnegative(), platform_price: z.number().nonnegative() }).passthrough(), last_updated_at_unix: z.number().int(), ran_against_draft: z.literal(true) }).passthrough();
export function scoreInvocation(raw: unknown, expected: { agentId: string; testId: string; invocationId: string; workspaceId: string; requestedModel: string; hostScript: string[]; judge: JudgeScenario }) {
  const invocation = z.object({ id: cleanId, test_runs: z.array(z.unknown()).length(1) }).passthrough().parse(raw);
  if (invocation.id !== expected.invocationId) throw new Error("Invocation identity mismatch");
  const run = terminalRunSchema.parse(invocation.test_runs[0]);
  if (run.agent_id !== expected.agentId || run.test_id !== expected.testId || run.test_invocation_id !== expected.invocationId || run.metadata.workspace_id !== expected.workspaceId) throw new Error("Provider test/account identity mismatch");
  const generated = run.agent_responses.filter(t => t.role === "agent" && (t.message || t.tool_calls?.length));
  if (!generated.length || generated.some(t => !t.producing_llm)) throw new Error("Served model telemetry missing from a generated agent turn");
  const servedModels = [...new Set(generated.map(t => t.producing_llm!))];
  const hostLines = run.agent_responses.filter(t => t.role === "user" && typeof t.message === "string").map(t => t.message!.trim());
  // Freeze case and punctuation normalization before either arm. Words and their order must match.
  const normalizeHost = (line:string) => line.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
  const scriptPassed = canonical(hostLines.map(normalizeHost)) === canonical(expected.hostScript.map(normalizeHost));
  const modelPassed = servedModels.length === 1 && servedModels[0] === expected.requestedModel;
  const judgment = judgeConversation(run.agent_responses, expected.judge);
  const providerPassed = run.status === "passed";
  const passed = scriptPassed && modelPassed && judgment.passed && providerPassed;
  return { passed, failureCategory: !scriptPassed ? "simulator_host_script" : !modelPassed ? "served_model_mismatch" : run.status === "cancelled" ? "simulation_cancelled" : !providerPassed ? "provider_content_evaluation" : !judgment.passed ? "conversation_checks" : null, providerStatus: run.status, providerPassed, servedModels, requestedModel: expected.requestedModel, identityEvidence: "Per-turn producing_llm, invocation/test/agent/workspace IDs, ran_against_draft; exact override bytes retained in private request, not echoed by provider", creditsUsed: run.credits_used, providerReportedUsd: run.charging.llm_price + run.charging.platform_price, costBasis: "Provider charging.llm_price + charging.platform_price, no inferred conversion", providerUpdatedAtUnix: run.last_updated_at_unix, judgment, scriptPassed, comparisonEligible: scriptPassed && modelPassed && run.status !== "cancelled", events: run.agent_responses.map(t => ({ role: t.role, message: t.message, tool_calls: t.tool_calls?.map(call => { const c = z.object({ tool_name: z.string(), params_as_json: z.string() }).parse(call); return { tool_name: c.tool_name, params_as_json: c.params_as_json }; }), producing_llm: t.producing_llm })) };
}
export function billingTelemetry(raw: unknown) {
  const run = z.object({ test_runs: z.array(z.record(z.string(), z.unknown())).length(1) }).safeParse(raw);
  const billingIssues: string[] = [];
  const field = (value: unknown, path: string, integer = false) => {
    const number = integer ? z.number().int().nonnegative() : z.number().finite().nonnegative();
    const parsed = number.safeParse(value);
    if (parsed.success) return parsed.data;
    billingIssues.push(path);
    return null;
  };
  const data = run.success ? run.data.test_runs[0] : undefined;
  const charging = z.record(z.string(), z.unknown()).safeParse(data?.charging);
  const creditsUsed = field(data?.credits_used, "credits_used", true);
  const llmPrice = field(charging.success ? charging.data.llm_price : undefined, "charging.llm_price");
  const platformPrice = field(charging.success ? charging.data.platform_price : undefined, "charging.platform_price");
  return { creditsUsed, providerReportedUsd: llmPrice !== null && platformPrice !== null ? llmPrice + platformPrice : null,
    billingState: billingIssues.length ? "missing_or_invalid" : "reported", billingIssues,
    billingComponents: { llmPrice, platformPrice },
    costBasis: "Provider charging.llm_price + charging.platform_price; valid components survive incomplete telemetry" };
}
function summary(state: Ledger) {
  const records: (Record<string, unknown> & { ordinal: number; arm: string; status: Attempt["status"]; failureCategory: string | null })[] = state.attempts.map(({ ordinal, arm, planSha256, status, failureCategory, record }) => ({ ordinal, arm, planSha256, status, failureCategory, ...record }));
  const succeeded = records.filter(r => r.status === "completed" && r.passed === true).length;
  return { protocol: PROTOCOL, attempted: records.length, succeeded, failed: records.filter(r => r.status === "failed" || r.status === "completed" && r.passed !== true).length, pendingOrUnknown: records.filter(r => ["intent", "unknown", "pending"].includes(r.status)).length, setupFailures: state.setupFailures, failureTaxonomy: records.reduce((acc, r) => { if (r.failureCategory) acc[r.failureCategory] = (acc[r.failureCategory] ?? 0) + 1; return acc; }, {} as Record<string, number>), realPhoneCalls: 0, limit: MAX_RUNS, mutationRequests: { attempted:state.mutations.length,succeeded:state.mutations.filter(m=>m.status==="succeeded").length,failed:state.mutations.filter(m=>m.status==="failed").length,unknown:state.mutations.filter(m=>m.status==="unknown" || m.status==="intent").length,records:state.mutations }, records };
}
function emit(state: Ledger) { const report = summary(state); mkdirSync("docs/evidence", { recursive: true }); save("docs/evidence/short-natural-simulations.json", report); console.log(JSON.stringify(report, null, 2)); }
export async function main(args = process.argv.slice(2)) {
  const [mode, arm, fixturePath] = args;
  if (!["plan", "run", "collect", "regrade", "summary"].includes(mode)) throw new Error("Usage: conversation-simulate.ts plan <arm> <fixture.json> | run <arm> | collect <ordinal> | regrade <ordinal> | summary");
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const lock = `${ROOT}/runner.lock`;
  mkdirSync(lock, { mode: 0o700 });
  try {
    if (mode === "summary") { emit(ledger()); return; }
    if (mode === "plan") {
      armId.parse(arm);
      if (!fixturePath) throw new Error("A fixture path is required");
      const config = z.object({ elevenAgentId: cleanId, voiceId: z.string().min(1) }).parse(load("private/service-config.json"));
      const fixture = fixtureSchema.parse(load(fixturePath));
      const definition = definitionSchema.parse(agentDefinition(config.voiceId));
      const identityTag = randomUUID();
      const account = z.object({user_id:z.string().min(1),workspace_id:z.string().min(1)}).parse(await request(`${API}/v1/user`, "GET", `${ROOT}/${arm}-plan-account-${identityTag}.raw.json`));
      const live = await request(`${API}/v1/convai/agents/${config.elevenAgentId}`, "GET", `${ROOT}/${arm}-plan-agent-${identityTag}.raw.json`);
      if (live.agent_id !== config.elevenAgentId) throw new Error("Plan agent identity mismatch");
      const liveConfiguration = {conversation_config:live.conversation_config,platform_settings:live.platform_settings};
      if (arm === "before" && (live.conversation_config?.agent?.prompt?.prompt !== definition.conversation_config.agent.prompt.prompt || live.conversation_config?.agent?.prompt?.llm !== definition.conversation_config.agent.prompt.llm || live.conversation_config?.agent?.prompt?.temperature !== definition.conversation_config.agent.prompt.temperature)) throw new Error("Before-arm prompt, model or temperature differs from the live agent");
      const plan = { protocol: PROTOCOL, arm, account, agentId: config.elevenAgentId, liveConfigurationSha256:hash(liveConfiguration), fixturePath, fixture, test: buildTest(fixture), override: { conversation_config: definition.conversation_config, platform_settings: definition.platform_settings }, sourceHashes: sourceHashes(fixturePath), maxRuns: MAX_RUNS, timeoutMs: 60000, implicitRetries: 0, simulationEndpoint: simulationEndpoint(config.elevenAgentId), mutations: ["Create one fictional simulation-only test if this exact fixture has not been created", "Submit exactly one run-tests invocation with a full agent configuration override; never dial or update an agent"] };
      const planSha256 = hash(plan);
      save(`${ROOT}/${arm}-plan.json`, { planSha256, plan });
      console.log(JSON.stringify({ planSha256, planPath: `${ROOT}/${arm}-plan.json`, mutationRequests: 0, realPhoneCalls: 0 }));
      return;
    }
    const state = ledger();
    if (mode === "run") {
      armId.parse(arm); assertCanStart(state);
      const { planSha256, plan } = load(`${ROOT}/${arm}-plan.json`);
      if (hash(plan) !== planSha256 || canonical(sourceHashes(plan.fixturePath)) !== canonical(plan.sourceHashes)) throw new Error("Plan/source identity changed; prepare and review again");
      z.object({ verdict: z.literal("ship"), planSha256: z.literal(planSha256) }).parse(load(`${ROOT}/${arm}-review.json`));
      const runTag=randomUUID();
      const account = z.object({ user_id: z.string().min(1), workspace_id: z.string().min(1) }).parse(await request(`${API}/v1/user`, "GET", `${ROOT}/${arm}-account-${runTag}.raw.json`));
      const live = await request(`${API}/v1/convai/agents/${cleanId.parse(plan.agentId)}`, "GET", `${ROOT}/${arm}-agent-${runTag}.raw.json`);
      if (live.agent_id !== plan.agentId || canonical(account) !== canonical(plan.account)) throw new Error("Agent/account readback identity mismatch");
      if (hash({conversation_config:live.conversation_config,platform_settings:live.platform_settings}) !== plan.liveConfigurationSha256) throw new Error("Live configuration drifted since review; prepare and review again");
      const testHash = hash(plan.test);
      let test = state.tests[testHash];
      if (!test) {
        state.tests[testHash] = { status: "intent" }; const mutation:Mutation={kind:"test_creation",status:"intent",failureCategory:null};state.mutations.push(mutation); persist(state);
        try { const created = z.object({ id: cleanId }).parse(await request(`${API}/v1/convai/agent-testing/create`, "POST", `${ROOT}/${arm}-test-create.raw.json`, plan.test)); test = state.tests[testHash] = { status: "ready", id: created.id }; mutation.status="succeeded";persist(state); }
        catch (error) { mutation.status="unknown";mutation.failureCategory=error instanceof ProviderError ? error.category : "provider_response_shape";if (error instanceof ProviderError && error.status && error.status >= 400 && error.status < 500) { state.tests[testHash].status = "failed"; state.setupFailures++;mutation.status="failed"; }persist(state);emit(state); throw error; }
      }
      if (test.status !== "ready" || !test.id) throw new Error("Test creation failed or uncertain; reconcile the private ledger before continuing");
      const readback = await request(`${API}/v1/convai/agent-testing/${cleanId.parse(test.id)}`, "GET", `${ROOT}/${arm}-test.raw.json`);
      if (readback.id !== test.id || readback.type !== "simulation" || !matchesRequested(readback, plan.test)) throw new Error("Simulation test readback differs from reviewed fixture");
      const attempt: Attempt = { ordinal: state.attempts.length + 1, arm, planSha256, status: "intent", failureCategory: null, testId: test.id };
      const requestBody = { tests: [{ test_id: test.id }], repeat_count: 1, agent_config_override: plan.override };
      save(`${ROOT}/run-${attempt.ordinal}-request.json`, requestBody);
      save(`${ROOT}/run-${attempt.ordinal}-manifest.json`, { planSha256, plan, workspaceId: account.workspace_id, userId: account.user_id, testId: test.id, requestedConfigurationSha256: hash(plan.override), servedConfigurationSha256: null, servedConfigurationNote: "Provider does not echo exact configuration override bytes. The request is retained; independently observed model and override execution flag are checked." });
      const mutation:Mutation={kind:"simulation_run",status:"intent",failureCategory:null};state.mutations.push(mutation);state.attempts.push(attempt); persist(state);
      try {
        const accepted = z.object({ id: cleanId, test_runs: z.array(z.object({ agent_id: cleanId, test_id: cleanId, test_invocation_id: cleanId })).length(1) }).passthrough().parse(await request(plan.simulationEndpoint, "POST", `${ROOT}/run-${attempt.ordinal}-start.raw.json`, requestBody));
        if (accepted.test_runs[0].agent_id !== plan.agentId || accepted.test_runs[0].test_id !== test.id || accepted.test_runs[0].test_invocation_id !== accepted.id) throw new Error("Started simulation identity mismatch");
        attempt.invocationId = accepted.id; attempt.status = "pending"; mutation.status="succeeded";persist(state);
        console.log(JSON.stringify({ attempted: state.attempts.length, succeeded: 0, failed: 0, pending: 1, ordinal: attempt.ordinal, next: `collect ${attempt.ordinal}`, realPhoneCalls: 0 }));
      } catch (error) {
        const knownRejected = error instanceof ProviderError && [401, 403, 422].includes(error.status!);
        attempt.status = knownRejected ? "failed" : "unknown"; attempt.failureCategory = error instanceof ProviderError ? error.category : "provider_identity_or_response_shape";
        mutation.status=knownRejected ? "failed" : "unknown";mutation.failureCategory=attempt.failureCategory;if (knownRejected) state.setupFailures++; persist(state); emit(state); throw error;
      }
      return;
    }
    const ordinal = z.coerce.number().int().positive().parse(arm);
    const attempt = state.attempts.find(a => a.ordinal === ordinal);
    if (!attempt?.invocationId) throw new Error("This attempt has no known invocation ID; reconcile privately instead of resubmitting");
    const manifest = load(`${ROOT}/run-${ordinal}-manifest.json`);
    if (mode !== "regrade" && (fileHash("test/conversation-judge.ts") !== manifest.plan.sourceHashes.judge || fileHash("scripts/conversation-simulate.ts") !== manifest.plan.sourceHashes.runner)) throw new Error("Runner/judge changed after submission; explicitly regrade with new protocol evidence instead of silently rescoring");
    const pollPath = mode === "regrade" ? `${ROOT}/run-${ordinal}-final.raw.json` : `${ROOT}/run-${ordinal}-poll-${randomUUID()}.raw.json`;
    const raw = mode === "regrade" ? load(pollPath) : await request(`${API}/v1/convai/test-invocations/${cleanId.parse(attempt.invocationId)}`, "GET", pollPath);
    const status = z.object({ id: z.literal(attempt.invocationId), test_runs: z.array(z.object({ status: z.string() })).length(1) }).parse(raw);
    if (status.test_runs[0].status === "pending") { console.log(JSON.stringify({ ordinal, status: "pending", repeat: "collect only; do not start another simulation" })); return; }
    const rawText = readFileSync(pollPath, "utf8");
    writeFileSync(`${ROOT}/run-${ordinal}-final.raw.json`, rawText, { mode: 0o600 });
    try {
      const record = scoreInvocation(raw, { agentId: manifest.plan.agentId, testId: attempt.testId, invocationId: attempt.invocationId, workspaceId: manifest.workspaceId, requestedModel: manifest.plan.override.conversation_config.agent.prompt.llm, hostScript: manifest.plan.fixture.hostScript, judge: manifest.plan.fixture.judge });
      if(mode === "regrade") {const amendment={ordinal,originalSourceHashes:manifest.plan.sourceHashes,regradeSourceHashes:{runner:fileHash("scripts/conversation-simulate.ts"),judge:fileHash("test/conversation-judge.ts")},record};save(`${ROOT}/run-${ordinal}-regrade-${randomUUID()}.json`,amendment);console.log(JSON.stringify(amendment,null,2));return;}
      attempt.status = "completed"; attempt.failureCategory = record.failureCategory; attempt.record = { ...record, rawSha256: createHash("sha256").update(rawText).digest("hex"), requestedConfigurationSha256: manifest.requestedConfigurationSha256, servedConfigurationSha256: null, sourceHashes: manifest.plan.sourceHashes, timeoutMs: 60000, retries: 0 };
    } catch (error) { if(mode === "regrade") {save(`${ROOT}/run-${ordinal}-regrade-failure-${randomUUID()}.json`,{ordinal,category:"provider_telemetry_or_response_shape",sourceHashes:{runner:fileHash("scripts/conversation-simulate.ts"),judge:fileHash("test/conversation-judge.ts")},...billingTelemetry(raw)});throw error;}attempt.status = "failed"; attempt.failureCategory = "provider_telemetry_or_response_shape"; attempt.record = { rawSha256: createHash("sha256").update(rawText).digest("hex"), ...billingTelemetry(raw), comparisonEligible: false }; persist(state); emit(state); throw error; }
    persist(state); emit(state);
  } finally { rmSync(lock, { recursive: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof ProviderError ? error.category : error.message); process.exitCode = 1; });
