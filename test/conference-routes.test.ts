import { expect, it } from "vitest";
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import worker from "../src/index";
import { SqlStore } from "../src/store";
import { cfg, input } from "./fixtures";
import type { Env } from "../src/config";
import type { Task } from "../src/contracts";

async function setup() {
  const stub = env.CALLS.get(env.CALLS.newUniqueId());
  const bindings = { ...env, CALLS: { idFromName: () => stub.id, get: () => stub } } as unknown as Env;
  async function post(path: string, args: unknown) {
    const response = await stub.fetch("https://ledger/" + path, { method: "POST", body: JSON.stringify(args) });
    const body = await response.json() as any; expect(response.status).toBe(200); return body.data;
  }
  const started = await post("start", { ...input, task_type: "support", recipient: "+12125550123", owner_join: "when_live_agent" });
  await runDurableObjectAlarm(stub);
  async function task() {
    let result!: Task;
    await runInDurableObject(stub, async (_instance, state) => { result = new SqlStore(state.storage).get(started.call_id)!; });
    return result;
  }
  async function twilio(op: string, fields: Record<string, string>, query = "") {
    const url = cfg.publicOrigin + "/webhooks/twilio/inbound?op=" + op + query;
    const form = new URLSearchParams({ AccountSid: cfg.twilioAccountSid, ...fields });
    const data = url + [...form.keys()].sort().map(key => key + form.get(key)).join("");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("synthetic-runtime-token"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
    return worker.fetch(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body: form }), bindings, createExecutionContext());
  }
  const invite = async (token: string, id = started.call_id) => worker.fetch(new Request(cfg.publicOrigin + "/webhooks/twilio/inbound?op=owner", { method: "POST", headers: { "Content-Type": "application/json", Authorization: token }, body: JSON.stringify({ call_id: id }) }), bindings, createExecutionContext());
  const prepared = await task();
  const registration = await twilio("assistant", { CallSid: prepared.conference!.legs.assistant.sid!, Param_call_id: prepared.id });
  expect(registration.status).toBe(200);
  await runDurableObjectAlarm(stub);
  return { stub, bindings, started, post, task, twilio, invite };
}

it("executes signed conference callbacks, raw TwiML registration, owner acceptance and all-leg cancellation", async () => {
  const s = await setup(), task = await s.task();
  const assistant = await s.twilio("assistant", { CallSid: task.conference!.legs.assistant.sid!, Param_call_id: task.id });
  expect(assistant.status).toBe(200); expect(await assistant.text()).toContain('<Stream url="wss://synthetic');
  const invited = await s.invite(`Bearer ${task.conference!.token}`);
  expect(invited.status).toBe(200); expect(await invited.json()).toMatchObject({ ok: true, data: { assistant_stays: true, accepted: false } });
  const owner = (await s.task()).conference!.legs.owner.sid!;
  const answer = await s.twilio("owner-answer", { CallSid: owner }, "&call_id=" + task.id);
  expect(answer.status).toBe(200); expect(await answer.text()).toContain("<Gather");
  const accept = await s.twilio("owner-accept", { CallSid: owner, Digits: "1" }, "&call_id=" + task.id);
  expect(accept.status).toBe(200); expect(await accept.text()).toContain("<Conference");
  const active = await s.post("get", { call_id: task.id });
  expect(active.owner_connection.accepted).toBe(true); expect(active.conference.participants.assistant.telephone_status).toBe("in-progress");
  expect(active.provider.call_sid).toBe(task.conference!.legs.business.sid);
  const canceled = await s.post("cancel", { call_id: task.id });
  expect(canceled.termination_confirmed).toBe(true); expect(canceled.conference.closed).toBe(true);
  for (const role of ["business", "assistant", "owner"]) expect(canceled.conference.participants[role].telephone_status).toBe("completed");
  expect(JSON.stringify(canceled)).not.toContain(task.conference!.token);
});

it("rejects unsigned callbacks and a forged or cross-call owner tool token", async () => {
  const s = await setup(), task = await s.task();
  const wrong = await s.invite("Bearer wrong"); expect(wrong.status).toBe(401);
  const other = await setup();
  expect((await other.invite(`Bearer ${task.conference!.token}`)).status).toBe(401);
  const unsigned = await worker.fetch(new Request(cfg.publicOrigin + "/webhooks/twilio/inbound?op=assistant", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ AccountSid: cfg.twilioAccountSid, CallSid: task.conference!.legs.assistant.sid!, ApplicationSid: cfg.twilioApplicationSid!, Param_call_id: task.id }) }), s.bindings, createExecutionContext());
  expect(unsigned.status).toBe(401);
  expect((await s.task()).conference!.legs.owner.status).toBe("not_started");
  await s.post("cancel", { call_id: task.id }); await other.post("cancel", { call_id: other.started.call_id });
});

it("rejects an unrequested owner callback and a callback naming another participant", async () => {
  const s = await setup(), task = await s.task();
  const wrongCall = await s.twilio("assistant", { CallSid: task.conference!.legs.business.sid!, Param_call_id: task.id });
  expect(wrongCall.status).toBe(502);
  const notInvited = await s.twilio("owner-accept", { CallSid: task.conference!.legs.business.sid!, Digits: "1" }, "&call_id=" + task.id);
  expect(notInvited.status).not.toBe(200); expect((await s.task()).conference!.ownerAccepted).toBe(false);
  await s.post("cancel", { call_id: task.id });
});
