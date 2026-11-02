import { describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { startSchema, type ConferenceRole, type Task, type PhoneStatus } from "../src/contracts";
import { configSchema } from "../src/config";
import { AGENT_PROMPT } from "../src/agent";
import { cfg, input, NOW, fakeProviders, conversation } from "./fixtures";
import { CallEngine } from "../src/engine";
import { SqlStore } from "../src/store";
import { LiveConferenceProviders, type ConferenceProviders } from "../src/conference-provider";
import { ProviderHttpError, type TwilioCall } from "../src/providers";
import type { Env } from "../src/config";

const conferenceConfig = { ...cfg, callbackNumber: "+12025550199", twilioApplicationSid: "AP" + "a".repeat(32) };
const support = { ...input, task_type: "support" as const, recipient: "+12125550123", owner_join: "when_live_agent" as const };
const sids = { business: "CA" + "3".repeat(32), assistant: "CA" + "4".repeat(32), owner: "CA" + "5".repeat(32) };
// Owner invitation attempts in dialing order; the first keeps the established owner call ID.
const ownerSids = [sids.owner, "CA" + "7".repeat(32), "CA" + "8".repeat(32), "CA" + "9".repeat(32)];
const roomSid = "CF" + "6".repeat(32);
const appSid = "CA" + "a".repeat(32);
const xml = '<Response><Connect><Stream url="wss://synthetic.example.invalid/audio"/></Connect></Response>';
async function scenario(fn: (s: ReturnType<typeof makeScenario>) => Promise<void>, autoRegister = true) {
  const stub = env.CALLS.get(env.CALLS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => { await fn(makeScenario(new SqlStore(state.storage), autoRegister)); });
}
function makeScenario(store: SqlStore, autoRegister = true) {
  let now = NOW;
  let engine!: CallEngine;
  const statuses: Record<ConferenceRole, PhoneStatus> = { business: "in-progress", assistant: "in-progress", owner: "in-progress" };
  const appStatus = { value: "in-progress" as PhoneStatus };
  // A per-attempt owner status overrides the shared owner status for that call ID only.
  const ownerStatus: Record<string, PhoneStatus> = {};
  // A per-attempt owner price overrides the default price; null means not yet available.
  const ownerPrice: Record<string, string | null> = {};
  const call = (role: ConferenceRole, sid: string = sids[role]): TwilioCall => ({ sid, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: role === "business" ? support.recipient : role === "owner" ? cfg.selfNumber : "app:" + conferenceConfig.twilioApplicationSid, status: role === "owner" ? ownerStatus[sid] ?? statuses.owner : statuses[role], price: role === "owner" && sid in ownerPrice ? ownerPrice[sid] : "-0.01", price_unit: "USD", start_time: null, duration: null });
  const transport = {
    create: vi.fn(async (task: Task, role: ConferenceRole) => {
      if (role === "assistant" && autoRegister) await engine.conferences!.assistant(task.id, appSid);
      // Index by dial count, so a dial whose response was lost still owns its call ID.
      if (role === "owner") return { callSid: ownerSids[ownerDialCount() - 1] };
      return { callSid: sids[role], conferenceSid: roomSid };
    }),
    observe: vi.fn(async (_task: Task, role: ConferenceRole, sid: string) => call(role, sid)),
    observeApp: vi.fn(async (_task: Task, sid: string) => ({ ...call("assistant", sid), to: conferenceConfig.twilioApplicationSid, status: appStatus.value })),
    resolveSip: vi.fn(async () => { throw Error("Legacy App transport cannot resolve a SIP call"); }),
    finish: vi.fn(async (task: Task, role: ConferenceRole) => { if (role === "owner") ownerStatus[task.conference!.legs.owner.sid!] = "completed"; else statuses[role] = "completed"; }),
    finishApp: vi.fn(async () => { appStatus.value = "completed"; }),
    close: vi.fn(async () => {}), register: vi.fn(async () => xml),
  } satisfies ConferenceProviders;
  const providers = fakeProviders();
  engine = new CallEngine(store, providers, conferenceConfig, () => now, transport);
  const ownerDialCount = () => transport.create.mock.calls.filter(([, role]) => role === "owner").length;
  // Report the given final status for one owner attempt through a signed status callback.
  const endOwner = async (id: string, attempt: number, status: PhoneStatus) => { ownerStatus[ownerSids[attempt - 1]] = status; await engine.conferences!.status(id, "owner", ownerSids[attempt - 1]); };
  return { engine, transport, providers, statuses, appStatus, ownerStatus, ownerPrice, call, ownerDialCount, endOwner, advance: (n: number) => { now += n; }, restart: () => new CallEngine(store, providers, conferenceConfig, () => now, transport) };
}
const idOf = (r: Record<string, unknown>) => r.call_id as string;

describe("owner joins while the assistant stays", () => {
  it("accepts an explicit request to add the owner when a live representative answers", () => {
    expect(startSchema.safeParse({ ...input, recipient: "+12125550123", owner_join: "when_live_agent" }).success).toBe(true);
  });
  it("accepts the dedicated TwiML application configuration", () => {
    expect(configSchema.safeParse({ ...cfg, twilioApplicationSid: "AP" + "a".repeat(32) }).success).toBe(true);
  });
  it("tells the assistant to remain and help after connecting the owner", () => {
    expect(AGENT_PROMPT).toContain("connect_owner");
    expect(AGENT_PROMPT).toContain("Stay on the call");
  });
  it("leaves existing calls on the original outbound path", () => scenario(async s => {
    await s.engine.start(input); await s.engine.tick();
    expect(s.providers.dispatch).toHaveBeenCalledTimes(1); expect(s.transport.create).not.toHaveBeenCalled();
  }));
  it("fails before saving or dialing if conference setup is absent", () => scenario(async s => {
    const engine = new CallEngine(s.engine.store, s.providers, { ...cfg, twilioApplicationSid: undefined }, () => NOW, s.transport);
    await expect(engine.start(support)).rejects.toMatchObject({ code: "SETUP_REQUIRED" });
    expect(s.transport.create).not.toHaveBeenCalled(); expect(engine.store.list(undefined, 10)).toEqual([]);
  }));
  it.each(["self", cfg.selfNumber])("rejects adding the owner when the original destination is %s", recipient => scenario(async s => {
    await expect(s.engine.start({ ...support, recipient })).rejects.toMatchObject({ code: "INVALID_OWNER_JOIN" });
    expect(s.transport.create).not.toHaveBeenCalled();
  }));
  it("connects the assistant and business without dialing the owner while they wait", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    expect(s.transport.create.mock.calls.map(([, role]) => role)).toEqual(["assistant", "business"]);
    expect(s.providers.dispatch).not.toHaveBeenCalled();
    const task = s.engine.require(id);
    expect(task.callSid).toBe(sids.business); expect(task.conference?.legs.assistant.sid).toBe(sids.assistant);
    expect(task.conference?.legs.owner.status).toBe("not_started");
  }));
  it("adds the owner at most once during concurrent tool calls and after restart", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    await Promise.all([s.engine.conferences!.connectOwner(id), s.engine.conferences!.connectOwner(id)]);
    await s.restart().conferences!.connectOwner(id);
    expect(s.transport.create.mock.calls.map(([, role]) => role)).toEqual(["assistant", "business", "owner"]);
    expect(s.transport.finish).not.toHaveBeenCalled();
    expect(s.engine.require(id).callSid).toBe(sids.business);
  }));
  it("does not join voicemail or treat answering as owner acceptance", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    const answer = await s.engine.conferences!.ownerAnswer(id, sids.owner);
    expect(answer).toContain("<Gather"); expect(answer).toContain("Press 1"); expect(answer).not.toContain("<Conference");
    expect(answer.match(/<Gather [^>]*>/g)).toEqual([expect.stringContaining('numDigits="1" timeout="30">')]);
    expect(s.engine.require(id).conference?.ownerAccepted).toBe(false);
    expect(await s.engine.conferences!.ownerAnswer(id, sids.owner, "2")).toBe("<Response><Hangup/></Response>");
    const accepted = await s.engine.conferences!.ownerAnswer(id, sids.owner, "1");
    expect(accepted).toContain("<Conference"); expect(s.engine.require(id).conference?.ownerAccepted).toBe(true);
    expect(s.transport.finish).not.toHaveBeenCalled();
  }));
  it("gives the owner 30 seconds to press 1 and plays the prompt when detection is unknown", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    const answer = await s.engine.conferences!.ownerAnswer(id, sids.owner, undefined, "unknown");
    expect(answer.match(/<Gather [^>]*>/g)).toEqual([expect.stringContaining('numDigits="1" timeout="30">')]);
    expect(answer).toContain("Press 1");
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).attempts).toEqual([expect.objectContaining({ call_sid: sids.owner, answered_by: "unknown" })]);
  }));
  it("hangs up on a voicemail answer without the prompt and retries about 10 seconds later", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    expect(await s.engine.conferences!.ownerAnswer(id, sids.owner, undefined, "machine_start")).toBe("<Response><Hangup/></Response>");
    await s.endOwner(id, 1, "completed"); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(1);
    expect(s.engine.conferences!.ownerView(s.engine.require(id))).toMatchObject({ attempts_used: 1, next_attempt_at: new Date(NOW + 10_000).toISOString() });
    s.advance(10_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2); expect(s.engine.require(id).conference?.legs.owner.sid).toBe(ownerSids[1]);
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).attempts.map(a => a.answered_by)).toEqual(["machine_start", null]);
  }));
  it("invites the owner at most three times, one attempt at a time", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    const misses: PhoneStatus[] = ["no-answer", "busy", "failed"];
    for (const [index, status] of misses.entries()) {
      const attempt = index + 1;
      expect(s.ownerDialCount()).toBe(attempt);
      await s.endOwner(id, attempt, status); await s.engine.tick();
      // The next invitation waits about 10 seconds and never overlaps the ended one.
      expect(s.ownerDialCount()).toBe(attempt);
      s.advance(10_000); await s.engine.tick();
    }
    s.advance(60_000); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    expect(s.ownerDialCount()).toBe(3);
    expect(s.engine.conferences!.ownerView(s.engine.require(id))).toMatchObject({ attempts_used: 3, max_attempts: 3, next_attempt_at: null, accepted: false });
    expect(s.engine.require(id).conference?.closed).toBe(false);
  }));
  it("stops retrying once the owner accepts, even after the owner later leaves", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    await s.endOwner(id, 1, "no-answer"); await s.engine.tick(); s.advance(10_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    expect(await s.engine.conferences!.ownerAnswer(id, ownerSids[1], undefined, "human")).toContain("<Gather");
    expect(await s.engine.conferences!.ownerAnswer(id, ownerSids[1], "1")).toContain("<Conference");
    await s.endOwner(id, 2, "completed"); await s.engine.tick(); s.advance(30_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    expect(s.engine.conferences!.ownerView(s.engine.require(id))).toMatchObject({ accepted: true, attempts_used: 2, next_attempt_at: null });
  }));
  it.each(["assistant", "business"] as const)("stops retrying when the %s leg ends and the conference closes", role => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    await s.endOwner(id, 1, "no-answer"); await s.engine.tick(); s.advance(10_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    await s.endOwner(id, 2, "busy"); await s.engine.tick();
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).next_attempt_at).not.toBeNull();
    s.statuses[role] = "completed"; await s.engine.conferences!.status(id, role, sids[role]); await s.engine.tick();
    expect(s.engine.require(id).conference?.closed).toBe(true);
    s.advance(10_000); await s.engine.tick(); s.advance(60_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).next_attempt_at).toBeNull();
  }));
  it("stops retrying after cancellation", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    await s.endOwner(id, 1, "no-answer"); await s.engine.tick(); s.advance(10_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    await s.endOwner(id, 2, "no-answer"); await s.engine.tick();
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).next_attempt_at).not.toBeNull();
    expect((await s.engine.cancel(id)).termination_confirmed).toBe(true);
    s.advance(10_000); await s.engine.tick(); s.advance(60_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).next_attempt_at).toBeNull();
  }));
  it("never adds an attempt for duplicate callbacks, replays, concurrent work or a restart", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    await s.endOwner(id, 1, "no-answer"); await s.endOwner(id, 1, "no-answer");
    await Promise.all([s.engine.tick(), s.restart().tick()]);
    s.advance(10_000);
    await Promise.all([s.engine.tick(), s.restart().tick(), s.engine.conferences!.status(id, "owner", ownerSids[0]), s.engine.conferences!.connectOwner(id)]);
    expect(s.ownerDialCount()).toBe(2);
    // A replayed answer or keypress from the ended first attempt neither joins nor accepts.
    expect(await s.engine.conferences!.ownerAnswer(id, ownerSids[0], "1")).toBe("<Response><Hangup/></Response>");
    expect(await s.engine.conferences!.ownerAnswer(id, ownerSids[0])).toBe("<Response><Hangup/></Response>");
    await s.endOwner(id, 1, "no-answer"); await s.engine.tick(); s.advance(30_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    expect(s.engine.require(id).conference).toMatchObject({ ownerAccepted: false, legs: { owner: { sid: ownerSids[1] } } });
  }));
  it("keeps the assistant and business connected if the owner does not answer", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    s.statuses.owner = "no-answer"; await s.engine.tick();
    const result = await s.engine.conferences!.connectOwner(id);
    expect(result).toMatchObject({ status: "no-answer", accepted: false, assistant_stays: true });
    expect(s.engine.require(id).conference?.closed).toBe(false); expect(s.transport.finish).not.toHaveBeenCalled();
    expect(s.transport.create).toHaveBeenCalledTimes(3);
  }));
  it("persists uncertain dialing and never sends a second invitation", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    s.transport.create.mockRejectedValueOnce(new Error("synthetic dispatch timeout"));
    expect(await s.engine.conferences!.connectOwner(id)).toMatchObject({ status: "dispatch_unknown" });
    await s.restart().conferences!.connectOwner(id); await s.engine.tick();
    // Long enough for any scheduled retry to come due twice.
    for (let i = 0; i < 4; i++) { s.advance(30_000); await s.engine.tick(); }
    expect(s.transport.create).toHaveBeenCalledTimes(3);
    expect(s.engine.conferences!.ownerView(s.engine.require(id))).toMatchObject({ attempts_used: 1, next_attempt_at: null });
    expect(s.engine.require(id).conference?.closed).toBe(false);
  }));
  it("stops inviting after the provider rejects an owner dial", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    s.transport.create.mockRejectedValueOnce(new ProviderHttpError(401)); await s.engine.conferences!.connectOwner(id);
    expect(s.engine.require(id).conference?.legs.owner.status).toBe("not_dispatched");
    for (let i = 0; i < 4; i++) { s.advance(30_000); await s.engine.tick(); }
    expect(s.ownerDialCount()).toBe(1);
    expect(s.engine.conferences!.ownerView(s.engine.require(id))).toMatchObject({ attempts_used: 1, next_attempt_at: null });
  }));
  it("keeps observing an ended invitation until its price arrives", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    s.ownerPrice[ownerSids[0]] = null;
    await s.endOwner(id, 1, "no-answer"); await s.engine.tick(); s.advance(10_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).attempts[0]).toMatchObject({ call_sid: ownerSids[0], cost_usd: null });
    delete s.ownerPrice[ownerSids[0]]; s.advance(15_000); await s.engine.tick();
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).attempts[0]).toMatchObject({ call_sid: ownerSids[0], cost_usd: 0.01 });
  }));
  it("retries an uncertain invitation only after a callback proves that it ended", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    s.transport.create.mockRejectedValueOnce(new Error("synthetic dispatch timeout")); await s.engine.conferences!.connectOwner(id);
    s.advance(30_000); await s.engine.tick(); expect(s.ownerDialCount()).toBe(1);
    await s.endOwner(id, 1, "no-answer"); await s.engine.tick(); s.advance(10_000); await s.engine.tick();
    expect(s.ownerDialCount()).toBe(2);
    expect(s.engine.conferences!.ownerView(s.engine.require(id)).attempts.map(a => a.call_sid)).toEqual([ownerSids[0], ownerSids[1]]);
  }));
  it("recovers an uncertain owner identity only after an authoritative observation", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    s.transport.create.mockRejectedValueOnce(new Error("timeout")); await s.engine.conferences!.connectOwner(id);
    await s.engine.conferences!.status(id, "owner", sids.owner);
    expect(s.engine.require(id).conference?.legs.owner).toMatchObject({ sid: sids.owner, status: "in-progress" });
    expect(s.transport.create).toHaveBeenCalledTimes(3);
  }));
  it("cancels all three participants and confirms their observed termination", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    const canceled = await s.engine.cancel(id);
    expect(s.transport.finish.mock.calls.map(([, role]) => role).sort()).toEqual(["assistant", "business", "owner"]);
    expect(s.transport.close).toHaveBeenCalled(); expect(canceled.termination_confirmed).toBe(true);
    expect(s.engine.require(id).conference?.closed).toBe(true);
  }));
  it("does not call a successful termination request confirmation", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    s.transport.finish.mockImplementation(async () => {});
    const canceled = await s.engine.cancel(id);
    expect(canceled.termination_confirmed).toBe(false); expect(s.engine.require(id).lastError?.code).toBe("TERMINATION_UNCONFIRMED");
    expect(s.engine.store.due(NOW + 15_000).map(t => t.id)).toContain(id);
  }));
  it("keeps the watchdog active when the business ends before other participants", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    s.statuses.business = "completed"; s.transport.finish.mockImplementation(async () => {});
    await s.engine.tick();
    expect(s.engine.require(id).telephone).toBe("completed"); expect(s.engine.require(id).conference?.closed).toBe(false);
    expect(s.engine.store.due(NOW + 15_000).map(t => t.id)).toContain(id);
  }));
  it("enforces the shared deadline even if conversation analysis is unavailable", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    s.providers.findConversation.mockRejectedValue(new Error("analysis offline")); s.advance(960_000); await s.engine.tick();
    expect(s.transport.finish).toHaveBeenCalledTimes(3); expect(s.engine.require(id).conference?.closed).toBe(true);
  }));
  it("cancels pending conference work without any dialing", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); expect((await s.engine.cancel(id)).termination_confirmed).toBe(true);
    expect(s.transport.create).not.toHaveBeenCalled();
  }));
  it("registers the assistant once and does not leak its secret in public results", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    expect(await s.engine.conferences!.assistant(id, appSid)).toBe(xml);
    expect(await s.restart().conferences!.assistant(id, appSid)).toBe(xml);
    expect(s.transport.register).toHaveBeenCalledTimes(1);
    const task = s.engine.require(id), serialized = JSON.stringify(s.engine.view(task));
    expect(serialized).not.toContain(task.conference!.token); expect(serialized).not.toContain("wss:");
    expect(s.engine.view(task).cost).toMatchObject({ twilio_usd: null });
  }));
  it("rejects conflicting participant identity and tool authorization", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    expect(() => s.engine.conferences!.authorize(id, "Bearer wrong")).toThrow();
    s.engine.conferences!.authorize(id, `Bearer ${s.engine.require(id).conference!.token}`);
    const registrations = s.transport.register.mock.calls.length;
    await expect(s.engine.conferences!.assistant(id, sids.owner)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await expect(s.engine.conferences!.status(id, "assistant", sids.owner)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    expect(s.transport.register).toHaveBeenCalledTimes(registrations);
  }));
  it("keeps conversation identity on the assistant leg and telephone identity on the business leg", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    const task = s.engine.require(id), result = conversation(task); result.metadata.phone_call!.call_sid = appSid;
    s.engine.conferences!.observeConversation(id, result, 10);
    expect(s.engine.require(id).callSid).toBe(sids.business); expect(s.engine.require(id).conversationId).toBe(result.conversation_id);
    const wrong = structuredClone(result); wrong.metadata.phone_call!.call_sid = sids.business;
    expect(() => s.engine.conferences!.observeConversation(id, wrong, 11)).toThrow();
  }));
  it("does not dial the business after a definitive assistant authentication rejection", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); s.transport.create.mockRejectedValueOnce(new ProviderHttpError(401));
    await s.engine.tick(); expect(s.transport.create).toHaveBeenCalledTimes(1);
    expect(s.engine.require(id).conference?.closed).toBe(true);
  }));
  it("does not dial the business until the assistant registration is ready", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    expect(s.transport.create.mock.calls.map(([, role]) => role)).toEqual(["assistant"]);
    await s.engine.conferences!.assistant(id, appSid); s.advance(15_000); await s.engine.tick();
    expect(s.transport.create.mock.calls.map(([, role]) => role)).toEqual(["assistant", "business"]);
  }, false));
  it("reopens cleanup when a late callback proves a rejected call exists", () => scenario(async s => {
    const id = idOf(await s.engine.start(support));
    const original = s.transport.create.getMockImplementation()!;
    s.transport.create.mockImplementation(async (task, role) => {
      if (role === "business") throw new ProviderHttpError(401);
      return original(task, role);
    });
    await s.engine.tick();
    await s.engine.conferences!.status(id, "business", sids.business);
    expect(s.engine.require(id).conference?.closed).toBe(false);
    await s.engine.tick();
    expect(s.transport.finish.mock.calls.some(([, role]) => role === "business")).toBe(true);
  }));
  it("clears a transient observation error after a healthy reconciliation", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    s.transport.observe.mockRejectedValueOnce(new Error("temporary provider outage"));
    s.advance(15_000); await s.engine.tick(); expect(s.engine.require(id).lastError).toBeDefined();
    s.advance(15_000); await s.engine.tick(); expect(s.engine.require(id).lastError).toBeUndefined();
  }));
  it("cleans up the business and owner promptly after the assistant disconnects", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    s.statuses.assistant = "completed";
    await s.engine.conferences!.status(id, "assistant", sids.assistant); await s.engine.tick();
    expect(s.engine.require(id).conference?.closed).toBe(true);
    expect(s.transport.finish.mock.calls.map(([, role]) => role).sort()).toEqual(["business", "owner"]);
  }));
  it("closes startup after the assistant disconnects without dialing the business", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    s.statuses.assistant = "completed";
    await s.engine.conferences!.status(id, "assistant", sids.assistant); await s.engine.tick();
    expect(s.engine.require(id).conference?.closed).toBe(true);
    expect(s.transport.create.mock.calls.map(([, role]) => role)).toEqual(["assistant"]);
  }, false));
  it("cleans up every participant when the receiving App call disconnects", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick(); await s.engine.conferences!.connectOwner(id);
    s.appStatus.value = "completed"; s.advance(15_000); await s.engine.tick();
    expect(s.engine.require(id).conference?.closed).toBe(true);
    expect(s.transport.finish.mock.calls.map(([, role]) => role).sort()).toEqual(["assistant", "business", "owner"]);
  }));
  it("keeps cancellation unconfirmed until the receiving App call has ended", () => scenario(async s => {
    const id = idOf(await s.engine.start(support)); await s.engine.tick();
    s.transport.finishApp.mockImplementation(async () => {});
    expect(await s.engine.cancel(id)).toMatchObject({ termination_confirmed: false, conference: { closed: false, assistant_connection: { call_sid: appSid, telephone_status: "in-progress" } } });
    s.appStatus.value = "completed"; await s.restart().reconcile(id);
    expect(s.engine.view(s.engine.require(id))).toMatchObject({ termination_confirmed: true, conference: { closed: true } });
    expect(s.transport.create).toHaveBeenCalledTimes(2);
  }));
});

describe("real conference provider adapter with synthetic HTTP", () => {
  function task(): Task { return { id: "11111111-1111-4111-8111-111111111111", input: support, to: support.recipient, created: Date.now(), expires: Date.now() + 100000, duration: 900, deadline: Date.now() + 900000, telephone: "pending", outcome: "pending", cancelRequested: false, nextCheck: NOW, attempts: 0 }; }
  it("creates a private AI app participant and owner acceptance call with the fixed self number", async () => {
    const t = task(), requests: { url: string; form: URLSearchParams }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), form: new URLSearchParams(init?.body as string) });
      if (String(url).endsWith("/Calls.json")) return Response.json({ sid: sids.owner, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: cfg.selfNumber, status: "queued", price: null, price_unit: null, start_time: null, duration: null });
      const label = new URLSearchParams(init?.body as string).get("Label");
      return Response.json({ account_sid: cfg.twilioAccountSid, conference_sid: roomSid, call_sid: label === "business" ? sids.business : sids.assistant, label });
    });
    const p = new LiveConferenceProviders({ TWILIO_AUTH_TOKEN: "synthetic" } as Env, conferenceConfig, fetcher);
    await p.create(t, "assistant"); await p.create(t, "owner"); await p.create(t, "business");
    expect(requests[0].form.get("To")).toBe(`app:${conferenceConfig.twilioApplicationSid}?call_id=${t.id}`);
    expect(requests[0].form.get("EndConferenceOnExit")).toBe("true"); expect(requests[0].form.get("ConferenceRecord")).toBe("do-not-record");
    expect(requests[1].form.get("To")).toBe(cfg.selfNumber); expect(requests[1].form.get("To")).not.toBe(conferenceConfig.callbackNumber);
    expect(requests[1].form.get("Url")).toContain("op=owner-answer");
    // The owner invitation rings 25 seconds, before carrier voicemail usually answers; the business and assistant legs keep 60.
    expect(requests.map(r => r.form.get("Timeout"))).toEqual(["60", "25", "60"]);
    expect(requests[2].form.get("To")).toBe(support.recipient); expect(requests[2].form.get("Label")).toBe("business");
    // Synchronous detection on the owner leg only, bounded so a human hears the prompt within about 5 seconds.
    expect(requests.map(r => r.form.get("MachineDetection"))).toEqual([null, "Enable", null]);
    expect(requests.map(r => r.form.get("MachineDetectionTimeout"))).toEqual([null, "5", null]);
    expect(requests[1].form.get("AsyncAmd")).toBeNull();
  });
  it("registers raw text TwiML and rejects JSON-wrapped connection output", async () => {
    const t = task(); t.input = { ...t.input, rules: ["Let the owner authenticate directly."] }; let body = xml;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(init!.body as string); expect(sent.to_number).toBe(t.to); expect(sent.conversation_initiation_client_data.user_id).toBe(t.id);
      expect(sent.conversation_initiation_client_data.dynamic_variables).toMatchObject({ owner_join: "when_live_agent", rules: JSON.stringify(t.input.rules) });
      expect(sent.conversation_initiation_client_data.conversation_config_override).toEqual({ conversation: { max_duration_seconds: 900 } });
      return new Response(body, { headers: { "Content-Type": "text/plain" } });
    });
    const p = new LiveConferenceProviders({ ELEVENLABS_API_KEY: "synthetic" } as Env, conferenceConfig, fetcher);
    expect(await p.register(t)).toBe(xml);
    body = JSON.stringify(xml); await expect(p.register(t)).rejects.toMatchObject({ code: "PROVIDER_SCHEMA" });
  });
  it("validates the App identity from the authoritative call destination", async () => {
    const t = task();
    const p = new LiveConferenceProviders({ TWILIO_AUTH_TOKEN: "synthetic" } as Env, conferenceConfig, async () => Response.json({ sid: sids.assistant, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: "app:AP" + "b".repeat(32), status: "in-progress", price: null, price_unit: null, start_time: null, duration: null }));
    await expect(p.observe(t, "assistant", sids.assistant)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });
  it("accepts the normalized App destination when observing and terminating its participant", async () => {
    const t = task();
    t.conference = { token: "synthetic", closed: false, closing: true, ownerAccepted: false, registration: "not_started", legs: { business: { status: "not_started" }, assistant: { sid: sids.assistant, status: "queued" }, owner: { status: "not_started" } } };
    const p = new LiveConferenceProviders({ TWILIO_AUTH_TOKEN: "synthetic" } as Env, conferenceConfig, async (_url, init) => Response.json({ sid: sids.assistant, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: "app:" + conferenceConfig.twilioApplicationSid, status: init?.method === "POST" ? "canceled" : "queued", price: null, price_unit: null, start_time: null, duration: null }));
    await expect(p.observe(t, "assistant", sids.assistant)).resolves.toMatchObject({ sid: sids.assistant, status: "queued" });
    await expect(p.finish(t, "assistant", "queued")).resolves.toBeUndefined();
  });
  it.each([
    { sid: sids.owner }, { account_sid: "AC" + "b".repeat(32) },
    { from: "+12025550122" }, { to: "AP" + "b".repeat(32) },
    { to: "app:" + conferenceConfig.twilioApplicationSid }, { direction: "outbound-api" },
  ])("rejects a receiving App call with mismatched identity %j", async wrong => {
    const p = new LiveConferenceProviders({ TWILIO_AUTH_TOKEN: "synthetic" } as Env, conferenceConfig, async () => Response.json({ sid: appSid, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: conferenceConfig.twilioApplicationSid, direction: "inbound", status: "in-progress", price: null, price_unit: null, start_time: null, duration: null, ...wrong }));
    await expect(p.observeApp(task(), appSid)).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });
  it("reconciles a cancelled startup whose App participant already ended without dialing again", () => scenario(async s => {
    const id = idOf(await s.engine.start(support));
    const t = s.engine.require(id);
    t.telephone = "dispatching"; t.cancelRequested = true;
    t.conference!.sid = roomSid; t.conference!.legs.assistant = { sid: sids.assistant, status: "queued" };
    t.lastError = { code: "IDENTITY_MISMATCH", message: "Synthetic earlier identity failure.", retryable: false };
    s.engine.store.put(t);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith(`/Calls/${sids.assistant}.json`) && init?.method === "GET") return Response.json({ sid: sids.assistant, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: "app:" + conferenceConfig.twilioApplicationSid, status: "busy", price: null, price_unit: "USD", start_time: null, duration: "0" });
      if (String(url).endsWith(`/Conferences/${roomSid}.json`) && init?.method === "GET") return Response.json({ sid: roomSid, account_sid: cfg.twilioAccountSid, friendly_name: "phone-" + id, status: "completed" });
      throw new Error("Unexpected provider request during cancelled startup reconciliation");
    });
    const p = new LiveConferenceProviders({ TWILIO_AUTH_TOKEN: "synthetic" } as Env, conferenceConfig, fetcher);
    const engine = new CallEngine(s.engine.store, s.providers, conferenceConfig, () => NOW, p);
    expect(await engine.cancel(id)).toMatchObject({ telephone_status: "not_dispatched", termination_confirmed: true, error: null, conference: { closed: true, participants: { assistant: { telephone_status: "busy" }, business: { telephone_status: "not_started" }, owner: { telephone_status: "not_started" } } } });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  }, false));
});
