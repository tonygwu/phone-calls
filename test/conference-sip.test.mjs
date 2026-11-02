import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runConferenceSip } from "../scripts/conference-sip.ts";
import { conferenceTools } from "../scripts/conference-setup.ts";
import { agentDefinition } from "../src/agent.ts";
import { canonical } from "../src/contracts.ts";
import { createHash } from "node:crypto";

const config = { publicOrigin: "https://calls.example.com", accessIssuer: "https://example.cloudflareaccess.com", accessAudience: "a".repeat(64), ownerEmail: "owner@example.com", ownerSubject: "owner-test", ownerName: "Test Owner", selfNumber: "+12025550123", callbackNumber: "+12025550199", fromNumber: "+14155550123", twilioAccountSid: "AC" + "1".repeat(32), twilioNumberSid: "PN" + "2".repeat(32), twilioApplicationSid: "AP" + "3".repeat(32), elevenAgentId: "agent_test", elevenPhoneId: "phone_test", voiceId: "stock_voice" };
const json = value => JSON.stringify(value, null, 2) + "\n", read = file => JSON.parse(readFileSync(file, "utf8"));
async function scenario(fn, existingOwner = true) {
  const cwd = mkdtempSync(join(tmpdir(), "conference-sip-test-")), at = name => join(cwd, name);
  mkdirSync(at("private"));
  writeFileSync(at("private/service-config.json"), json(config));
  writeFileSync(at("private/worker-secrets.json"), json({ SERVICE_CONFIG: JSON.stringify(config), ELEVENLABS_API_KEY: "synthetic-eleven-secret", TWILIO_AUTH_TOKEN: "synthetic-twilio-secret", ELEVENLABS_WEBHOOK_SECRET: "preserved-postcall-secret" }));
  let agent = { ...agentDefinition(config.voiceId), agent_id: config.elevenAgentId, name: "Owner custom name", version_id: "before_version", branch_id: "main_branch", main_branch_id: "main_branch", workflow: { preserved: true } };
  agent.conversation_config.agent.first_message = "Owner custom opener";
  agent.conversation_config.agent.prompt.llm = "owner-selected-model";
  agent.platform_settings.workspace_overrides = { webhooks: { post_call_webhook_id: "existing_postcall", events: ["transcript"] } };
  agent.conversation_config.agent.prompt.tool_ids = existingOwner ? ["existing_owner_tool"] : [];
  const tools = new Map(existingOwner ? [["existing_owner_tool", { id: "existing_owner_tool", tool_config: conferenceTools(config.publicOrigin)[0] }]] : []);
  const secrets = new Map(), routes = new Map(), requests = [];
  let beforeRequest;
  const fetcher = async (input, init) => {
    const url = new URL(String(input)), method = init.method;
    assert.equal(init.redirect, "error");
    requests.push({ url: url.href, method, body: init.body });
    if (beforeRequest) { const response = await beforeRequest(url, init); if (response) return response; }
    if (url.hostname === "api.twilio.com" && url.pathname === `/2010-04-01/Accounts/${config.twilioAccountSid}.json` && method === "GET") return Response.json({ sid: config.twilioAccountSid, status: "active" });
    assert.equal(url.hostname, "api.elevenlabs.io"); assert.equal(init.headers["xi-api-key"], "synthetic-eleven-secret");
    if (url.pathname === "/v1/user" && method === "GET") return Response.json({ user_id: "synthetic_user", workspace_id: "synthetic_workspace" });
    if (url.pathname === `/v1/convai/agents/${config.elevenAgentId}`) {
      if (method === "GET") return Response.json(agent);
      if (method === "PATCH") { agent = { ...agent, ...JSON.parse(init.body), version_id: "after_version" }; return Response.json(agent); }
    }
    if (url.pathname === "/v1/convai/secrets") {
      if (method === "POST") { const body = JSON.parse(init.body); assert.equal(body.type, "new"); assert.match(body.value, /^Bearer [a-f0-9]{64}$/); const stored = { type: "stored", secret_id: "created_header_secret", name: body.name }; secrets.set(stored.secret_id, stored); return Response.json(stored); }
      if (method === "GET") return Response.json({ secrets: [...secrets.values()].filter(secret => secret.name.startsWith(url.searchParams.get("search"))), next_cursor: null });
    }
    if (url.pathname === "/v1/convai/phone-numbers") {
      if (method === "GET") return Response.json([{ provider: "twilio", assigned_agent: null }]);
      if (method === "POST") { const body = JSON.parse(init.body); assert.equal(body.provider, "sip_trunk"); assert(!("outbound_trunk_config" in body)); assert.equal(body.inbound_trunk_config.media_encryption, "required"); const route = { phone_number_id: "created_sip_route", provider: "sip_trunk", phone_number: body.phone_number, assigned_agent: { agent_id: body.agent_id }, supports_inbound: true, supports_outbound: false, inbound_trunk: { media_encryption: "required", has_auth_credentials: true, username: body.inbound_trunk_config.credentials.username } }; routes.set(route.phone_number_id, route); return Response.json({ phone_number_id: route.phone_number_id }); }
    }
    for (const [id, route] of routes) if (url.pathname === `/v1/convai/phone-numbers/${id}` && method === "GET") return Response.json(route);
    if (url.pathname === "/v1/convai/tools" && method === "POST") { const tool = { id: "created_owner_tool", tool_config: JSON.parse(init.body).tool_config }; tools.set(tool.id, tool); return Response.json(tool); }
    for (const [id, tool] of tools) if (url.pathname === `/v1/convai/tools/${id}` && method === "GET") return Response.json(tool);
    throw Error("Unexpected synthetic SIP setup request " + method + " " + url.pathname);
  };
  const options = { cwd, fetcher }, prepare = () => runConferenceSip("prepare", options), apply = () => runConferenceSip("apply", options);
  const approve = () => writeFileSync(at("private/conference-sip/review.json"), json({ verdict: "ship", planSha256: read(at("private/conference-sip/plan.json")).planSha256 }));
  try { await fn({ cwd, at, prepare, apply, approve, requests, routes, tools, getAgent: () => agent, setAgent: value => { agent = value; }, setBeforeRequest: value => { beforeRequest = value; } }); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("SIP prepare reads identities and preserves exact agent settings without mutations", () => scenario(async s => {
  const before = structuredClone(s.getAgent()), result = await s.prepare();
  assert.equal(result.externalChanges, 0); assert.equal(result.realPhoneCalls, 0); assert.equal(result.createsOwnerTool, false);
  assert(s.requests.every(request => request.method === "GET"));
  const plan = read(s.at("private/conference-sip/plan.json")).plan;
  assert.deepEqual(plan.agentBefore, before); assert.equal(plan.mutations.ownerTool, null);
  assert.equal(plan.mutations.route.body.inbound_trunk_config.media_encryption, "required");
  assert.equal(plan.mutations.agent.body.conversation_config.agent.prompt.llm, "owner-selected-model");
  assert.deepEqual(plan.mutations.agent.body.platform_settings.workspace_overrides.webhooks, before.platform_settings.workspace_overrides.webhooks);
  assert.equal(statSync(s.at("private/conference-sip/plan.json")).mode & 0o777, 0o600);
}));
test("unreviewed SIP apply fails before any provider request", () => scenario(async s => {
  await s.prepare(); s.requests.length = 0; await assert.rejects(s.apply()); assert.equal(s.requests.length, 0);
}));
test("SIP apply creates a route and header secret, reuses the owner tool, preserves settings, and never dials", () => scenario(async s => {
  const before = structuredClone(s.getAgent()); await s.prepare(); s.approve(); const result = await s.apply();
  assert.equal(result.realPhoneCalls, 0); assert.equal(result.deployed, false); assert.equal(result.toolId, "existing_owner_tool");
  assert.equal(s.requests.filter(request => request.method === "POST").length, 2); assert.equal(s.requests.filter(request => request.method === "PATCH").length, 1);
  assert(s.requests.every(request => !/Calls|Conferences|outbound-call|register-call|Applications/.test(request.url)));
  const after = s.getAgent(); assert.equal(after.name, before.name); assert.deepEqual(after.workflow, before.workflow);
  assert.equal(after.conversation_config.agent.first_message, before.conversation_config.agent.first_message); assert.equal(after.conversation_config.agent.prompt.llm, before.conversation_config.agent.prompt.llm);
  assert.deepEqual(after.platform_settings.workspace_overrides.webhooks, before.platform_settings.workspace_overrides.webhooks);
  assert.deepEqual(after.platform_settings.workspace_overrides.conversation_initiation_client_data_webhook, { url: config.publicOrigin + "/webhooks/twilio/inbound?op=sip", request_headers: { Authorization: { secret_id: "created_header_secret" } } });
  const stored = read(s.at("private/service-config.json")), secrets = read(s.at("private/worker-secrets.json"));
  assert.deepEqual({ ...stored, conferenceSip: undefined }, { ...config, conferenceSip: undefined });
  assert.equal(stored.conferenceSip.phoneId, "created_sip_route"); assert.deepEqual(JSON.parse(secrets.SERVICE_CONFIG), stored);
  assert.equal(secrets.ELEVENLABS_WEBHOOK_SECRET, "preserved-postcall-secret"); assert.match(secrets.ELEVENLABS_SIP_PASSWORD, /^[a-f0-9]{64}$/); assert.match(secrets.ELEVENLABS_INITIATION_SECRET, /^[a-f0-9]{64}$/);
  assert.equal(statSync(s.at("private/worker-secrets.json")).mode & 0o777, 0o600);
  const mutations = s.requests.filter(request => request.method !== "GET").length; await s.apply();
  assert.equal(s.requests.filter(request => request.method !== "GET").length, mutations);
}));
test("a fresh installation creates only the missing owner tool", () => scenario(async s => {
  await s.prepare(); s.approve(); await s.apply(); assert.equal(s.requests.filter(request => request.method === "POST").length, 3);
  assert.deepEqual(s.getAgent().conversation_config.agent.prompt.tool_ids, ["created_owner_tool"]);
}, false));
test("an unknown route creation blocks every resumed request and does not repeat a mutation", () => scenario(async s => {
  await s.prepare(); s.approve(); s.setBeforeRequest((url, init) => { if (init.method === "POST" && url.pathname === "/v1/convai/phone-numbers") throw Error("synthetic lost create response"); });
  await assert.rejects(s.apply(), /transport failed/);
  assert.equal(read(s.at("private/conference-sip/journal.json")).steps.route.state, "intent");
  s.requests.length = 0; await assert.rejects(s.apply(), /uncertain/); assert.equal(s.requests.length, 0);
  assert.equal(read(s.at("private/service-config.json")).conferenceSip, undefined);
}));
test("agent drift aborts before resource creation", () => scenario(async s => {
  await s.prepare(); s.approve(); s.setAgent({ ...s.getAgent(), version_id: "changed_version" }); s.requests.length = 0;
  await assert.rejects(s.apply(), /agent changed/); assert(s.requests.every(request => request.method === "GET"));
}));
test("unrelated local secret drift aborts before provider requests", () => scenario(async s => {
  await s.prepare(); s.approve(); const file = s.at("private/worker-secrets.json"), value = read(file); value.ELEVENLABS_WEBHOOK_SECRET = "changed-after-review"; writeFileSync(file, json(value)); s.requests.length = 0;
  await assert.rejects(s.apply(), /secrets changed/); assert.equal(s.requests.length, 0);
}));
test("route readback requires digest authentication and never patches the agent after a mismatch", () => scenario(async s => {
  await s.prepare(); s.approve(); s.setBeforeRequest((url, init) => {
    if (init.method === "GET" && url.pathname === "/v1/convai/phone-numbers/created_sip_route") return Response.json({ ...s.routes.get("created_sip_route"), inbound_trunk: { media_encryption: "required", has_auth_credentials: false, username: "wrong" } });
  });
  await assert.rejects(s.apply()); assert.equal(s.requests.filter(request => request.method === "PATCH").length, 0);
  assert.equal(read(s.at("private/conference-sip/journal.json")).steps.route.state, "done");
}));
test("owner-tool drift aborts before creating resources", () => scenario(async s => {
  await s.prepare(); s.approve();
  const tool = structuredClone(s.tools.get("existing_owner_tool")); tool.tool_config.api_schema.url = "https://other.example.com/"; s.tools.set(tool.id, tool); s.requests.length = 0;
  await assert.rejects(s.apply()); assert.equal(s.requests.filter(request => request.method !== "GET").length, 0);
}));
test("unknown header-secret creation retains intent and blocks automatic resume", () => scenario(async s => {
  await s.prepare(); s.approve(); s.setBeforeRequest((url, init) => {
    if (init.method === "POST" && url.pathname === "/v1/convai/secrets") return Response.json({ type: "stored", name: "missing-id" });
  });
  await assert.rejects(s.apply()); assert.equal(read(s.at("private/conference-sip/journal.json")).steps.headerSecret.state, "intent");
  s.requests.length = 0; await assert.rejects(s.apply(), /uncertain/); assert.equal(s.requests.length, 0);
}));
test("completed provider operations recover either half of local configuration writes without another mutation", () => scenario(async s => {
  const originalConfig = read(s.at("private/service-config.json")), originalSecrets = read(s.at("private/worker-secrets.json"));
  await s.prepare(); s.approve(); await s.apply();
  const afterConfig = read(s.at("private/service-config.json")), mutations = s.requests.filter(request => request.method !== "GET").length;
  writeFileSync(s.at("private/service-config.json"), json(originalConfig)); await s.apply(); assert.deepEqual(read(s.at("private/service-config.json")), afterConfig);
  writeFileSync(s.at("private/worker-secrets.json"), json(originalSecrets)); await s.apply(); assert.deepEqual(JSON.parse(read(s.at("private/worker-secrets.json")).SERVICE_CONFIG), afterConfig);
  assert.equal(s.requests.filter(request => request.method !== "GET").length, mutations);
}));
test("a saved inline projection of referenced webhook and built-in tools is preserved without sending deprecated tools", () => scenario(async s => {
  const before = s.getAgent();
  before.conversation_config.agent.prompt.tools = [structuredClone(s.tools.get("existing_owner_tool").tool_config), ...Object.values(before.conversation_config.agent.prompt.built_in_tools).filter(Boolean)];
  s.setAgent(before); await s.prepare(); s.approve(); await s.apply();
  const patch = JSON.parse(s.requests.find(request => request.method === "PATCH").body);
  assert(!Object.hasOwn(patch.conversation_config.agent.prompt, "tools"));
  assert.deepEqual(patch.conversation_config.agent.prompt.tool_ids, ["existing_owner_tool"]);
}));
test("an inline webhook without an exact referenced definition aborts before mutation", () => scenario(async s => {
  const before = s.getAgent();
  const tool = structuredClone(s.tools.get("existing_owner_tool").tool_config); tool.api_schema.url = "https://unrepresented.example.com/";
  before.conversation_config.agent.prompt.tools = [tool]; s.setAgent(before);
  await assert.rejects(s.prepare()); assert(s.requests.every(request => request.method === "GET"));
}));
test("apply refuses a reviewed agent body that differs from the patch it would send", () => scenario(async s => {
  await s.prepare();
  const file = s.at("private/conference-sip/plan.json"), prepared = read(file);
  prepared.plan.mutations.agent.body.conversation_config.agent.prompt.prompt = "A different reviewed prompt";
  prepared.planSha256 = createHash("sha256").update(canonical(prepared.plan)).digest("hex");
  writeFileSync(file, json(prepared)); s.approve(); s.requests.length = 0;
  await assert.rejects(s.apply()); assert.equal(s.requests.length, 0);
}));
test("SIP setup selects audible keypad tones after validating the original projection and preserves other tool fields", () => scenario(async s => {
  const before = s.getAgent(), tone = before.conversation_config.agent.prompt.built_in_tools.play_keypad_touch_tone;
  tone.params = { ...tone.params, use_out_of_band_dtmf: true, suppress_turn_after_dtmf: true };
  tone.description = "Owner custom keypad description";
  before.conversation_config.agent.prompt.tools = [structuredClone(s.tools.get("existing_owner_tool").tool_config), ...Object.values(before.conversation_config.agent.prompt.built_in_tools).filter(Boolean)];
  s.setAgent(before); await s.prepare();
  const plan = read(s.at("private/conference-sip/plan.json")).plan;
  assert.equal(plan.agentBefore.conversation_config.agent.prompt.built_in_tools.play_keypad_touch_tone.params.use_out_of_band_dtmf, true);
  const next = plan.mutations.agent.body.conversation_config.agent.prompt.built_in_tools.play_keypad_touch_tone;
  assert.equal(next.params.use_out_of_band_dtmf, false);
  assert.equal(next.params.suppress_turn_after_dtmf, true); assert.equal(next.description, tone.description);
  assert.deepEqual(plan.mutations.agent.body.conversation_config.agent.prompt.built_in_tools.end_call, before.conversation_config.agent.prompt.built_in_tools.end_call);
  s.approve(); await s.apply();
  assert.equal(s.getAgent().conversation_config.agent.prompt.built_in_tools.play_keypad_touch_tone.params.use_out_of_band_dtmf, false);
}));
