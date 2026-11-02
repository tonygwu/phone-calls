import { describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { CallEngine } from "../src/engine";
import { LiveConferenceProviders } from "../src/conference-provider";
import { configSchema, type Env } from "../src/config";
import { conversationSchema, correlate } from "../src/providers";
import { SqlStore } from "../src/store";
import { cfg, input, NOW, fakeProviders, conversation } from "./fixtures";
import type { ConferenceRole, PhoneStatus, Task } from "../src/contracts";

const sip = { identifier: "assistant-test", phoneId: "sip_phone_test", username: "assistant-user" };
const config = { ...cfg, twilioApplicationSid: undefined, conferenceSip: sip };
const support = { ...input, task_type: "support", recipient: "+12125550123", owner_join: "when_live_agent", max_duration_seconds: 420 };
const destination = `sip:${sip.identifier}@sip.rtc.elevenlabs.io:5061;transport=tls;secure=true`;
const sids = { assistant: "CA" + "4".repeat(32), business: "CA" + "3".repeat(32), owner: "CA" + "5".repeat(32) };
const room = "CF" + "6".repeat(32);
const source = (id: string) => "assistant-" + id;
function sipConversation(task: Task) {
  const value: any = conversation(task);
  value.conversation_id = "sip_conversation";
  value.status = "in-progress";
  value.metadata.phone_call = { type: "sip_trunking", direction: "inbound", call_sid: sids.assistant, phone_number_id: sip.phoneId, agent_number: sip.identifier, external_number: "provider-reported-source" };
  return value;
}
async function scenario(fn: (s: any) => Promise<void>) {
  const stub = env.CALLS.get(env.CALLS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new SqlStore(state.storage), providers = fakeProviders();
    let id = "", now = NOW;
    const status: Record<ConferenceRole, PhoneStatus> = { assistant: "in-progress", business: "in-progress", owner: "in-progress" };
    const call = (role: ConferenceRole) => ({ sid: sids[role], account_sid: cfg.twilioAccountSid, direction: "outbound-api", from: role === "assistant" ? source(id) : cfg.fromNumber, to: role === "assistant" ? destination : role === "owner" ? cfg.selfNumber : support.recipient, status: status[role], price: null, price_unit: "USD", start_time: null, duration: null });
    const transport = {
      create: vi.fn(async (task: Task, role: ConferenceRole) => { id = task.id; return { callSid: sids[role], conferenceSid: room }; }),
      observe: vi.fn(async (_task: Task, role: ConferenceRole) => call(role)),
      resolveSip: vi.fn(async () => ({ taskId: id, call: call("assistant") })),
      observeApp: vi.fn(async () => { throw Error("SIP must not create or observe an App call"); }),
      register: vi.fn(async () => { throw Error("SIP must not register a separate Stream call"); }),
      finish: vi.fn(async (_task: Task, role: ConferenceRole) => { status[role] = "completed"; }),
      finishApp: vi.fn(async () => { throw Error("SIP has no App call to stop"); }), close: vi.fn(async () => {}),
    };
    const engine = new CallEngine(store, providers, config as any, () => now, transport as any);
    providers.conversation.mockImplementation(async () => sipConversation(engine.require(id)));
    await fn({ engine, store, providers, transport, status, call, advance: (n: number) => { now += n; } });
  });
}

describe("direct SIP conference transport", () => {
  it("accepts complete SIP configuration without a TwiML App and rejects partial configuration", () => {
    expect(configSchema.safeParse(config).success).toBe(true);
    expect(configSchema.safeParse({ ...config, conferenceSip: { identifier: sip.identifier } }).success).toBe(false);
    expect(configSchema.safeParse({ ...config, conferenceSip: { ...sip, identifier: "sip:someone@example.net" } }).success).toBe(false);
  });
  it("creates one encrypted, authenticated SIP participant without an ElevenLabs registration request", async () => {
    const task = { id: crypto.randomUUID(), to: support.recipient, input: support, duration: 420, created: NOW, deadline: Date.now() + 420000, conference: { assistantTransport: "sip", legs: { assistant: { status: "dispatching" } } } } as unknown as Task;
    const requests: { url: string; form: URLSearchParams }[] = [];
    const provider = new LiveConferenceProviders({ TWILIO_AUTH_TOKEN: "synthetic", ELEVENLABS_SIP_PASSWORD: "synthetic-sip-password" } as Env, config as any, async (url, init) => {
      requests.push({ url: String(url), form: new URLSearchParams(String(init?.body)) });
      return Response.json({ account_sid: cfg.twilioAccountSid, conference_sid: room, call_sid: sids.assistant, label: "assistant" });
    });
    await provider.create(task, "assistant");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/Participants.json");
    const body = requests[0].form;
    expect(body.get("To")).toBe(destination); expect(body.get("From")).toBe(source(task.id));
    expect(body.get("SipAuthUsername")).toBe(sip.username); expect(body.get("SipAuthPassword")).toBe("synthetic-sip-password");
    expect(body.get("EndConferenceOnExit")).toBe("true"); expect(body.get("MaxParticipants")).toBe("3");
  });
  it.each([
    { account_sid: "AC" + "b".repeat(32) }, { sid: sids.business }, { from: cfg.fromNumber },
    { to: "sip:someone@sip.rtc.elevenlabs.io:5061;transport=tls;secure=true" }, { direction: "inbound" },
  ])("rejects an unrelated authoritative SIP call before binding or stopping it: %j", async wrong => {
    const taskId = crypto.randomUUID(), methods: string[] = [];
    const provider = new LiveConferenceProviders({ TWILIO_AUTH_TOKEN: "synthetic" } as Env, config as any, async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ sid: sids.assistant, account_sid: cfg.twilioAccountSid, from: source(taskId), to: destination, direction: "outbound-api", status: "in-progress", price: null, price_unit: "USD", start_time: null, duration: null, ...wrong });
    });
    await expect(provider.resolveSip(sids.assistant)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    const task = { id: taskId, conference: { assistantTransport: "sip", legs: { assistant: { sid: sids.assistant } } } } as unknown as Task;
    await expect(provider.finish(task, "assistant", "in-progress")).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(methods).toEqual(["GET", "GET"]);
  });
  it("recovers a lost participant response through initialization without redial", () => scenario(async s => {
    const create = s.transport.create.getMockImplementation();
    s.transport.create.mockImplementationOnce(async (...args: any[]) => { await create(...args); throw Error("synthetic response lost after SIP dial"); });
    const id = (await s.engine.start(support)).call_id; await s.engine.tick();
    expect(s.engine.require(id).conference.legs.assistant.status).toBe("dispatch_unknown");
    await s.engine.conferences.sip(sids.assistant, "sip_conversation"); await s.engine.tick();
    expect(s.transport.create.mock.calls.map(([, role]: any[]) => role)).toEqual(["assistant", "business"]);
    expect(s.engine.require(id).conference.legs.assistant.sid).toBe(sids.assistant);
    await s.engine.cancel(id);
  }));
  it("keeps cancellation unconfirmed for an unknown SIP leg, then closes on a late status without dialing", () => scenario(async s => {
    const create = s.transport.create.getMockImplementation();
    s.transport.create.mockImplementationOnce(async (...args: any[]) => { await create(...args); throw Error("synthetic dial response lost"); });
    const id = (await s.engine.start(support)).call_id; await s.engine.tick();
    expect(await s.engine.cancel(id)).toMatchObject({ termination_confirmed: false });
    await s.engine.conferences.status(id, "assistant", sids.assistant); await s.engine.tick();
    expect(s.engine.view(s.engine.require(id))).toMatchObject({ termination_confirmed: true, conference: { closed: true } });
    expect(s.transport.create).toHaveBeenCalledTimes(1);
  }));
  it("waits for authenticated initiation, adds only three legs, accepts the owner and closes every leg", () => scenario(async s => {
    const started = await s.engine.start(support), id = started.call_id;
    await s.engine.tick();
    expect(s.transport.create.mock.calls.map(([, role]: any[]) => role)).toEqual(["assistant"]);
    const data = await s.engine.conferences.sip(sids.assistant, "sip_conversation");
    expect(data).toMatchObject({ type: "conversation_initiation_client_data", user_id: id, dynamic_variables: { call_id: id, objective: support.objective, secret__conference_token: `Bearer ${s.engine.require(id).conference.token}` } });
    await s.engine.tick(); await s.engine.conferences.connectOwner(id);
    expect(s.transport.create.mock.calls.map(([, role]: any[]) => role)).toEqual(["assistant", "business", "owner"]);
    expect(s.transport.register).not.toHaveBeenCalled(); expect(s.transport.observeApp).not.toHaveBeenCalled();
    expect(s.engine.require(id).conference.assistantApp).toBeUndefined();
    expect(await s.engine.conferences.ownerAnswer(id, sids.owner, "1")).toContain("<Conference");
    expect(s.engine.view(s.engine.require(id))).toMatchObject({ owner_connection: { accepted: true }, provider: { call_sid: sids.business, conversation_id: "sip_conversation" } });
    const canceled = await s.engine.cancel(id);
    expect(canceled).toMatchObject({ termination_confirmed: true, conference: { closed: true, assistant_transport: "sip", assistant_connection: null } });
    expect(s.transport.finish.mock.calls.map(([, role]: any[]) => role).sort()).toEqual(["assistant", "business", "owner"]);
    expect(s.transport.finishApp).not.toHaveBeenCalled();
  }));
  it("replays initiation without redial and rejects another conversation or a closed task", () => scenario(async s => {
    const id = (await s.engine.start(support)).call_id; await s.engine.tick();
    const data = await s.engine.conferences.sip(sids.assistant, "sip_conversation");
    expect(await s.engine.conferences.sip(sids.assistant, "sip_conversation")).toEqual(data);
    await expect(s.engine.conferences.sip(sids.assistant, "different_conversation")).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(s.transport.create).toHaveBeenCalledTimes(1);
    await s.engine.cancel(id);
    await expect(s.engine.conferences.sip(sids.assistant, "sip_conversation")).rejects.toMatchObject({ code: "CALL_ENDED" });
  }));
  it("accepts SIP metadata only for the exact assistant call and route, preserving the business SID", () => scenario(async s => {
    const id = (await s.engine.start(support)).call_id; await s.engine.tick(); await s.engine.conferences.sip(sids.assistant, "sip_conversation"); await s.engine.tick();
    const task = s.engine.require(id), c = sipConversation(task);
    expect(conversationSchema.safeParse(c).success).toBe(true);
    s.engine.conferences.observeConversation(id, c, s.store.nextObservation());
    expect(s.engine.require(id).callSid).toBe(sids.business);
    for (const wrong of [{ call_sid: sids.business }, { phone_number_id: cfg.elevenPhoneId }, { type: "twilio", direction: "outbound" }]) {
      await expect(Promise.resolve().then(() => s.engine.conferences.observeConversation(id, { ...c, metadata: { ...c.metadata, phone_call: { ...c.metadata.phone_call, ...wrong } } }, s.store.nextObservation()))).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    }
    expect(() => correlate(task, c, config as any)).toThrow();
    await s.engine.cancel(id);
  }));
});
