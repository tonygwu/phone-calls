import { expect, it } from "vitest";
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import worker from "../src/index";
import { SqlStore } from "../src/store";
import { cfg, input, sipCfg } from "./data";
import type { Task } from "../src/contracts";
import type { Env } from "../src/config";

async function setup() {
  const stub = env.CALLS.get(env.CALLS.newUniqueId());
  const bindings = { ...env, CALLS: { idFromName: () => stub.id, get: () => stub } } as unknown as Env;
  async function post(path: string, body: unknown) {
    const res = await stub.fetch("https://ledger/" + path, { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200); return (await res.json() as any).data;
  }
  const started = await post("start", { ...input, task_type: "support", recipient: "+12125550123", owner_join: "when_live_agent" });
  await runDurableObjectAlarm(stub);
  async function task() {
    let result!: Task;
    await runInDurableObject(stub, async (_instance, state) => { result = new SqlStore(state.storage).get(started.call_id)!; });
    return result;
  }
  async function initiate(overrides: Record<string, unknown> = {}, authorization = "Bearer synthetic-initiation-secret") {
    const current = await task();
    return worker.fetch(new Request(cfg.publicOrigin + "/webhooks/twilio/inbound?op=sip", { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify({ agent_id: cfg.elevenAgentId, call_sid: current.conference!.legs.assistant.sid, conversation_id: current.id, ...overrides }) }), bindings, createExecutionContext());
  }
  async function twilio(op: string, fields: Record<string, string>) {
    const url = cfg.publicOrigin + "/webhooks/twilio/inbound?op=" + op + "&call_id=" + started.call_id;
    const form = new URLSearchParams({ AccountSid: cfg.twilioAccountSid, ...fields });
    const raw = url + [...form.keys()].sort().map(key => key + form.get(key)).join("");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("synthetic-runtime-token"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))));
    return worker.fetch(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: form }), bindings, createExecutionContext());
  }
  return { stub, bindings, started, task, post, initiate, twilio };
}

it("executes direct SIP initialization, three-party owner acceptance and all-leg cancellation through real routes", async () => {
  const s = await setup(), initial = await s.task();
  expect(initial.conference).toMatchObject({ assistantTransport: "sip", registration: "not_started", legs: { assistant: { status: "in-progress" }, business: { status: "not_started" } } });
  const response = await s.initiate(); expect(response.status).toBe(200);
  const data = await response.json();
  expect(data).toMatchObject({ type: "conversation_initiation_client_data", user_id: initial.id, dynamic_variables: { call_id: initial.id, owner_join: "when_live_agent", secret__conference_token: `Bearer ${initial.conference!.token}` } });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await runDurableObjectAlarm(s.stub);
  const active = await s.task(); expect(active.conference!.legs.business.status).toBe("in-progress"); expect(active.conference!.assistantApp).toBeUndefined();
  const invite = await worker.fetch(new Request(cfg.publicOrigin + "/webhooks/twilio/inbound?op=owner", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${active.conference!.token}` }, body: JSON.stringify({ call_id: active.id }) }), s.bindings, createExecutionContext());
  expect(invite.status).toBe(200);
  const owner = (await s.task()).conference!.legs.owner.sid!;
  expect((await s.twilio("owner-accept", { CallSid: owner, Digits: "1" })).status).toBe(200);
  const view = await s.post("get", { call_id: active.id });
  expect(view).toMatchObject({ owner_connection: { accepted: true }, conference: { assistant_transport: "sip", assistant_connection: null } });
  expect(view.provider.call_sid).toBe(active.conference!.legs.business.sid); expect(view.provider.conversation_id).toBe(active.id);
  expect(new Set(Object.values(view.conference.participants).map((leg: any) => leg.call_sid)).size).toBe(3);
  expect(await s.post("cancel", { call_id: active.id })).toMatchObject({ termination_confirmed: true, conference: { closed: true } });
});

it("rejects an unsigned initialization, wrong agent and conflicting conversation before releasing a task brief", async () => {
  const s = await setup();
  expect((await s.initiate({}, "Bearer wrong")).status).toBe(401);
  expect((await s.initiate({ agent_id: "another_agent" })).status).toBe(400);
  expect((await s.task()).conference!.registration).toBe("not_started");
  expect((await s.initiate()).status).toBe(200);
  const wrong = await s.initiate({ conversation_id: "different_conversation" }); expect(wrong.status).toBe(502);
  expect(JSON.stringify(await wrong.json())).not.toContain(input.context);
  await s.post("cancel", { call_id: s.started.call_id });
});

it("rejects a callback for the business leg and a late initiation after cancellation", async () => {
  const s = await setup(); expect((await s.initiate()).status).toBe(200); await runDurableObjectAlarm(s.stub);
  const task = await s.task();
  expect((await s.initiate({ call_sid: task.conference!.legs.business.sid })).status).toBe(502);
  await s.post("cancel", { call_id: task.id }); expect((await s.initiate()).status).toBe(409);
  expect((await s.task()).conversationId).toBe(task.id);
  expect(sipCfg.conferenceSip!.phoneId).toBeTruthy();
});
