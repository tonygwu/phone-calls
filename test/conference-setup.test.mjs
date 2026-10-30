import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runConferenceSetup, conferenceTools, conferenceAgentPatch, once, assertContains } from "../scripts/conference-setup.ts";

const config = {
  publicOrigin: "https://calls.example.com", accessIssuer: "https://example.cloudflareaccess.com", accessAudience: "a".repeat(64),
  ownerEmail: "owner@example.com", ownerSubject: "owner-test", ownerName: "Test Owner", selfNumber: "+12025550123", callbackNumber: "+12025550199", fromNumber: "+14155550123",
  twilioAccountSid: "AC" + "1".repeat(32), twilioNumberSid: "PN" + "2".repeat(32), elevenAgentId: "agent_test", elevenPhoneId: "phone_test", voiceId: "stock_voice",
};
const applicationSid = "AP" + "3".repeat(32);
const json = value => JSON.stringify(value, null, 2) + "\n";
const read = file => JSON.parse(readFileSync(file, "utf8"));
function scenario(fn) {
  const cwd = mkdtempSync(join(tmpdir(), "conference-setup-test-"));
  mkdirSync(join(cwd, "private")); mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/agent.ts"), "synthetic-source-identity");
  writeFileSync(join(cwd, "private/service-config.json"), json(config));
  writeFileSync(join(cwd, "private/worker-secrets.json"), json({ SERVICE_CONFIG: JSON.stringify(config), ELEVENLABS_API_KEY: "synthetic-eleven-secret", TWILIO_AUTH_TOKEN: "synthetic-twilio-secret", ELEVENLABS_WEBHOOK_SECRET: "preserved-webhook-secret" }));
  const env = { TWILIO_ACCOUNT_SID: config.twilioAccountSid, TWILIO_AUTH_TOKEN: "synthetic-twilio-secret", ELEVENLABS_API_KEY: "synthetic-eleven-secret" };
  let savedAgent = { agent_id: config.elevenAgentId, name: "Owner's custom name", platform_settings: { owner_setting: true }, conversation_config: {
    agent: { first_message: "Owner's custom opener", prompt: { prompt: "Owner's old prompt", llm: "owner-custom-model", temperature: .5, tool_ids: ["owner_existing_tool"], knowledge_base: [{ id: "owner_knowledge" }], built_in_tools: { end_call: { type: "system" } } } },
    asr: { provider: "owner-asr", user_input_audio_format: "pcm_16000" },
    tts: { voice_id: "owner-custom-voice", agent_output_audio_format: "pcm_16000" },
    conversation: { max_duration_seconds: 600 },
  } };
  const requests = [], tools = new Map();
  let beforeRequest;
  const fetcher = async (input, init) => {
    const url = String(input), method = init.method;
    requests.push({ url, method, body: init.body, redirect: init.redirect });
    assert.equal(init.redirect, "error");
    if (beforeRequest) { const intercepted = await beforeRequest(url, init); if (intercepted) return intercepted; }
    if (url === `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}.json` && method === "GET") return Response.json({ sid: config.twilioAccountSid, status: "active" });
    if (url === "https://api.elevenlabs.io/v1/user" && method === "GET") return Response.json({ user_id: "synthetic_user", workspace_id: "synthetic_workspace" });
    if (url === `https://api.elevenlabs.io/v1/convai/agents/${config.elevenAgentId}`) {
      if (method === "GET") return Response.json(savedAgent);
      if (method === "PATCH") { savedAgent = { ...savedAgent, ...JSON.parse(init.body) }; return Response.json(savedAgent); }
    }
    if (url === `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Applications.json` && method === "POST") {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("PublicApplicationConnectEnabled"), "false");
      return Response.json({ sid: applicationSid, account_sid: config.twilioAccountSid, voice_url: form.get("VoiceUrl"), voice_method: "POST", public_application_connect_enabled: false });
    }
    if (url === `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Applications/${applicationSid}.json` && method === "GET") return Response.json({ sid: applicationSid, account_sid: config.twilioAccountSid, voice_url: config.publicOrigin + "/webhooks/twilio/inbound?op=assistant", voice_method: "POST", public_application_connect_enabled: false });
    if (url === "https://api.elevenlabs.io/v1/convai/tools" && method === "POST") {
      const body = JSON.parse(init.body), id = `created_tool_${tools.size}`;
      const response = { id, tool_config: { ...body.tool_config, provider_default: true } }; tools.set(id, response); return Response.json(response);
    }
    for (const [id, tool] of tools) if (url === `https://api.elevenlabs.io/v1/convai/tools/${id}` && method === "GET") return Response.json(tool);
    throw new Error("Unexpected request in synthetic setup test");
  };
  const options = { cwd, env, fetcher };
  const at = path => join(cwd, path);
  const prepare = () => runConferenceSetup("prepare", options);
  const approve = () => writeFileSync(at("private/conference-setup/review.json"), json({ verdict: "ship", planSha256: read(at("private/conference-setup/plan.json")).planSha256, compatibleWorkerDeployed: true }));
  const apply = () => runConferenceSetup("apply", options);
  return Promise.resolve().then(() => fn({ cwd, at, options, prepare, approve, apply, requests, tools, setBeforeRequest: fn => { beforeRequest = fn; }, getAgent: () => savedAgent, setAgent: value => { savedAgent = value; } })).finally(() => rmSync(cwd, { recursive: true, force: true }));
}

test("webhook schema binds the call ID and secret header without exposing them to the model", () => {
  const tools = conferenceTools(config.publicOrigin); assert.equal(tools.length, 1);
  const owner = tools[0]; assert.equal(owner.name, "connect_owner");
  assert.deepEqual(owner.api_schema.request_headers.Authorization, { variable_name: "secret__conference_token" });
  assert.deepEqual(owner.api_schema.request_body_schema.properties.call_id, { type: "string", dynamic_variable: "call_id" });
  assert.deepEqual(owner.api_schema.request_body_schema.required, ["call_id"]);
  assert.equal(owner.follow_redirects, false);
  assert.equal(owner.api_schema.url, config.publicOrigin + "/webhooks/twilio/inbound?op=owner");
});

test("prepare reads only identities and agent, and records an exact prompt replacement without mutations", () => scenario(async s => {
  const before = structuredClone(s.getAgent()); const result = await s.prepare();
  assert.equal(result.externalChanges, 0); assert.equal(result.realPhoneCalls, 0);
  assert.ok(s.requests.every(r => r.method === "GET")); assert.equal(s.requests.length, 3);
  const prepared = read(s.at("private/conference-setup/plan.json"));
  assert.deepEqual(prepared.plan.agentBefore, before);
  assert.equal(prepared.plan.mutations.agent.body.conversation_config.agent.prompt.llm, "owner-custom-model");
  assert.equal(prepared.plan.mutations.agent.body.conversation_config.agent.prompt.prompt.includes("automated telephone assistant"), true);
  assert.equal(prepared.plan.mutations.agent.body.conversation_config.asr.user_input_audio_format, "ulaw_8000");
  assert.equal(statSync(s.at("private/conference-setup/plan.json")).mode & 0o777, 0o600);
}));

test("unreviewed plan refuses apply before any provider request or mutation", () => scenario(async s => {
  await s.prepare(); s.requests.length = 0;
  await assert.rejects(s.apply()); assert.equal(s.requests.length, 0);
}));

test("saved legacy system-tool projection is omitted when attaching tool IDs", () => scenario(async s => {
  const before = s.getAgent();
  const end = { type: "system", name: "end_call", params: { system_tool_type: "end_call" } };
  before.conversation_config.agent.prompt.built_in_tools = { end_call: end };
  before.conversation_config.agent.prompt.tools = [end];
  s.setAgent(before);
  s.setBeforeRequest((_url, init) => {
    if (init.method === "PATCH") {
      const prompt = JSON.parse(init.body).conversation_config.agent.prompt;
      if ("tools" in prompt && prompt.tool_ids.length) return Response.json({ detail: { status: "both_tools_and_tool_ids_provided" } }, { status: 400 });
    }
  });
  await s.prepare(); s.approve(); await s.apply();
  const patch = JSON.parse(s.requests.find(r => r.method === "PATCH").body);
  assert.ok(!Object.hasOwn(patch.conversation_config.agent.prompt, "tools"));
  assert.deepEqual(patch.conversation_config.agent.prompt.built_in_tools, { end_call: end });
  assert.deepEqual(s.getAgent().conversation_config.agent.prompt.tool_ids, ["owner_existing_tool", "created_tool_0"]);
}));

test("unrepresented legacy tools fail preparation before creating resources", () => scenario(async s => {
  const before = s.getAgent();
  before.conversation_config.agent.prompt.tools = [{ type: "webhook", name: "legacy_owner_tool" }];
  s.setAgent(before);
  await assert.rejects(s.prepare(), /legacy tools.*built_in_tools/);
  assert.ok(s.requests.every(r => r.method === "GET"));
}));

test("apply requires review evidence that the compatible Worker was deployed first", () => scenario(async s => {
  await s.prepare(); s.approve(); s.requests.length = 0;
  const file = s.at("private/conference-setup/review.json");
  const review = read(file); delete review.compatibleWorkerDeployed; writeFileSync(file, json(review));
  await assert.rejects(s.apply()); assert.equal(s.requests.length, 0);
}));

test("apply creates only one app and one tool, preserves owner settings and secrets, and never dials", () => scenario(async s => {
  const before = structuredClone(s.getAgent()); await s.prepare(); s.approve();
  const applied = await s.apply();
  assert.equal(applied.realPhoneCalls, 0); assert.equal(applied.deployed, false);
  assert.equal(applied.applicationSid, applicationSid); assert.deepEqual(applied.toolIds, ["created_tool_0"]);
  const changed = s.getAgent();
  assert.equal(changed.name, before.name); assert.deepEqual(changed.platform_settings, before.platform_settings);
  assert.equal(changed.conversation_config.agent.first_message, before.conversation_config.agent.first_message);
  assert.equal(changed.conversation_config.agent.prompt.llm, "owner-custom-model");
  assert.equal(changed.conversation_config.tts.voice_id, "owner-custom-voice");
  assert.deepEqual(changed.conversation_config.agent.prompt.tool_ids, ["owner_existing_tool", "created_tool_0"]);
  assert.deepEqual(changed.conversation_config.agent.prompt.knowledge_base, before.conversation_config.agent.prompt.knowledge_base);
  const stored = read(s.at("private/service-config.json")); assert.equal(stored.twilioApplicationSid, applicationSid);
  const secrets = read(s.at("private/worker-secrets.json")); assert.equal(secrets.ELEVENLABS_WEBHOOK_SECRET, "preserved-webhook-secret");
  assert.deepEqual(JSON.parse(secrets.SERVICE_CONFIG), stored);
  assert.equal(statSync(s.at("private/service-config.json")).mode & 0o777, 0o600);
  const writes = s.requests.filter(r => r.method !== "GET");
  assert.deepEqual(writes.map(r => r.method), ["POST", "POST", "PATCH"]);
  assert.ok(s.requests.every(r => !/Calls|Participants|outbound-call|register-call/.test(r.url)));
}));

test("a transport timeout after creation intent cannot duplicate resource creation on retry", () => scenario(async s => {
  await s.prepare(); s.approve();
  s.setBeforeRequest((url, init) => { if (init.method === "POST") throw new Error("synthetic private credential must not escape"); });
  await assert.rejects(s.apply(), /transport failed/);
  const journal = read(s.at("private/conference-setup/journal.json")); assert.equal(journal.steps.application.state, "intent");
  s.requests.length = 0; await assert.rejects(s.apply(), /uncertain/); assert.equal(s.requests.length, 0);
}));

test("agent edits after review stop apply before resource creation", () => scenario(async s => {
  await s.prepare(); s.approve();
  s.setAgent({ ...s.getAgent(), conversation_config: { ...s.getAgent().conversation_config, tts: { voice_id: "owner-new-voice" } } });
  await assert.rejects(s.apply(), /Saved agent changed after review/);
  assert.ok(s.requests.every(r => r.method === "GET"));
}));

test("concurrent setup attempts cannot both pass the mutation journal", () => scenario(async s => {
  await s.prepare(); s.approve(); s.requests.length = 0;
  let release, started; const held = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { started = resolve; });
  s.setBeforeRequest(async (url, init) => {
    if (url.endsWith(`${config.twilioAccountSid}.json`) && init.method === "GET") { started(); await held; }
  });
  const active = s.apply(); await observed;
  await assert.rejects(s.apply(), /execution lock/);
  assert.equal(s.requests.length, 1); release(); await active;
  assert.equal(s.requests.filter(r => r.method !== "GET").length, 3);
}));

test("changed source, config or plan is rejected before provider requests", async () => {
  for (const variant of ["source", "config", "plan"]) await scenario(async s => {
    await s.prepare(); s.approve(); s.requests.length = 0;
    if (variant === "source") writeFileSync(s.at("src/agent.ts"), "new-source");
    if (variant === "config") writeFileSync(s.at("private/service-config.json"), json({ ...config, selfNumber: "+12025550100" }));
    if (variant === "plan") { const plan = read(s.at("private/conference-setup/plan.json")); plan.plan.agentBeforeSha256 = "tampered"; writeFileSync(s.at("private/conference-setup/plan.json"), json(plan)); }
    await assert.rejects(s.apply()); assert.equal(s.requests.length, 0);
  });
});

test("provider response mismatch leaves intent for reconciliation", () => scenario(async s => {
  await s.prepare(); s.approve();
  s.setBeforeRequest((url, init) => init.method === "POST" ? Response.json({ sid: applicationSid, account_sid: "AC" + "4".repeat(32), voice_url: config.publicOrigin + "/webhooks/twilio/inbound?op=assistant", voice_method: "POST", public_application_connect_enabled: false }) : undefined);
  await assert.rejects(s.apply());
  assert.equal(read(s.at("private/conference-setup/journal.json")).steps.application.state, "intent");
}));

test("completed apply and recovery of local writes never repeat provider mutations", () => scenario(async s => {
  const secretsBefore = read(s.at("private/worker-secrets.json"));
  // Recovery must retain the exact original SERVICE_CONFIG string for hash comparison.
  secretsBefore.SERVICE_CONFIG = JSON.stringify(config, null, 2);
  writeFileSync(s.at("private/worker-secrets.json"), json(secretsBefore));
  await s.prepare(); s.approve(); await s.apply();
  s.requests.length = 0;
  const repeated = await s.apply(); assert.equal(repeated.alreadyApplied, true);
  assert.ok(s.requests.every(r => r.method === "GET"));
  const journal = read(s.at("private/conference-setup/journal.json")); journal.completed = false;
  writeFileSync(s.at("private/conference-setup/journal.json"), json(journal));
  s.requests.length = 0; await s.apply();
  assert.ok(s.requests.every(r => r.method === "GET"));
  assert.equal(read(s.at("private/conference-setup/journal.json")).completed, true);
}));

test("agent edits during resource creation refuse the update and preserve new owner settings", () => scenario(async s => {
  await s.prepare(); s.approve();
  s.setBeforeRequest((url, init) => {
    if (url.endsWith("/v1/convai/tools") && init.method === "POST") {
      const saved = s.getAgent();
      s.setAgent({ ...saved, conversation_config: { ...saved.conversation_config, conversation: { max_duration_seconds: 1200 } } });
    }
  });
  await assert.rejects(s.apply(), /Saved agent changed before update/);
  assert.equal(s.getAgent().conversation_config.conversation.max_duration_seconds, 1200);
  assert.equal(s.requests.filter(r => r.method === "PATCH").length, 0);
  const journal = read(s.at("private/conference-setup/journal.json"));
  assert.equal(journal.steps.application.state, "done"); assert.equal(journal.steps.ownerTool.state, "done");
  assert.equal(journal.steps.agent.state, "intent");
}));

test("journal reuses completed creation response and rejects absent recorded response", async () => {
  let attempts = 0, saves = 0; const journal = { steps: {}, completed: false, protocol: "owner-conference-setup-v1", planSha256: "a".repeat(64) };
  const action = async () => { attempts++; return { id: "created" }; }, persist = () => { saves++; };
  assert.deepEqual(await once(journal, "resource", persist, action), { id: "created" });
  assert.deepEqual(await once(journal, "resource", persist, action), { id: "created" });
  assert.equal(attempts, 1); assert.equal(saves, 2);
  journal.steps.invalid = { state: "done" }; await assert.rejects(once(journal, "invalid", persist, action), /lacks/);
});

test("readback permits provider defaults but rejects changed values and arrays", () => {
  assert.doesNotThrow(() => assertContains({ a: { b: 1, defaults: true } }, { a: { b: 1 } }));
  assert.throws(() => assertContains({ a: { b: 2 } }, { a: { b: 1 } }));
  assert.throws(() => assertContains({ a: ["wanted", "extra"] }, { a: ["wanted"] }));
});
