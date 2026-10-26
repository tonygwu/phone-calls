import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { CallEngine } from "../src/engine";
import { SqlStore } from "../src/store";
import { DAY, RETENTION, digest, startSchema } from "../src/contracts";
import { applyConversation, applyTwilio, correlate } from "../src/providers";
import { dispatchBody } from "../src/agent";
import { cfg, input, NOW, fakeProviders, conversation } from "./fixtures";

async function scenario(fn: (e: CallEngine, p: ReturnType<typeof fakeProviders>, advance: (n: number) => void) => Promise<void>) {
  const stub = env.CALLS.get(env.CALLS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    let now = NOW; const p = fakeProviders();
    const e = new CallEngine(new SqlStore(state.storage), p, structuredClone(cfg), () => now);
    await fn(e, p, n => { now += n; });
  });
}
const idOf = (value: Record<string, unknown>) => value.call_id as string;

describe("validation and spend admission", () => {
  it("rejects Canadian numbers, missing essentials and long reminders", async () => {
    expect(startSchema.safeParse({ ...input, recipient: "+14165550123" }).success).toBe(false);
    expect(startSchema.safeParse({ ...input, success_criteria: [] }).success).toBe(false);
    await scenario(async (e, p) => { await expect(e.start({ ...input, max_duration_seconds: 181 })).rejects.toMatchObject({ code: "DURATION_LIMIT" }); expect(p.dispatch).not.toHaveBeenCalled(); });
  });
  it("allows only the test destination before acceptance", async () => scenario(async (e, p) => {
    await expect(e.start({ ...input, recipient: "+12125550123" })).rejects.toMatchObject({ code: "TEST_DESTINATION_ONLY" }); expect(p.preflight).not.toHaveBeenCalled();
  }));
  it("reserves budget before dispatch and returns immediately", async () => scenario(async (e, p) => {
    const result = await e.start(input); const t = e.require(idOf(result));
    expect(result.telephone_status).toBe("pending"); expect(e.store.used("2026-10")).toBe(400000); expect(p.dispatch).not.toHaveBeenCalled();
    p.dispatch.mockImplementationOnce(async () => { expect(e.require(t.id).telephone).toBe("dispatching"); return { success: true, message: "ok", conversation_id: "conv_test", callSid: "CA" + "3".repeat(32) }; });
    await e.tick(); expect(p.dispatch).toHaveBeenCalledTimes(1);
  }));
  it("admits and dispatches calls after the legacy allowance timestamp", async () => scenario(async (e, p) => {
    e.config.budget.expiresAt = new Date(NOW - 1).toISOString();
    const id = idOf(await e.start(input));
    expect(e.require(id).telephone).toBe("pending");
    await e.tick();
    expect(p.dispatch).toHaveBeenCalledTimes(1);
    expect(e.require(id).telephone).toBe("queued");
  }));
  it("dispatches accepted calls when a legacy allowance timestamp passes", async () => scenario(async (e, p, advance) => {
    e.config.budget.expiresAt = new Date(NOW + 500).toISOString();
    const id = idOf(await e.start(input));
    advance(1000);
    await e.tick();
    expect(p.dispatch).toHaveBeenCalledTimes(1);
    expect(e.require(id).telephone).toBe("queued");
  }));
  it("still rejects provider checks older than the call admission window", async () => scenario(async (e, p) => {
    const quote = await p.preflight("", 0, NOW);
    p.preflight.mockResolvedValueOnce({ ...quote, checkedAt: NOW - 61000 });
    await expect(e.start(input)).rejects.toMatchObject({ code: "PRICING_EXPIRED" });
    expect(p.dispatch).not.toHaveBeenCalled();
  }));
  it("rejects exhaustion and unknown pricing without dialing", async () => scenario(async (e, p) => {
    p.preflight.mockResolvedValueOnce({ ...(await p.preflight("", 0, NOW)), reservationMicros: 9_000_000 });
    await expect(e.start(input)).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
    p.preflight.mockRejectedValueOnce(new Error("missing quote"));
    await expect(e.start(input)).rejects.toThrow("missing quote"); expect(p.dispatch).not.toHaveBeenCalled();
  }));
  it("deduplicates retries and rejects changed intent", async () => scenario(async (e, p) => {
    const first = await e.start(input); const second = await e.start(input); expect(first.call_id).toBe(second.call_id);
    await expect(e.start({ ...input, objective: "changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await e.tick(); await e.start(input); expect(p.dispatch).toHaveBeenCalledTimes(1);
  }));
  it("resolves concurrent starts to a single active call", async () => scenario(async (e, p) => {
    const results = await Promise.allSettled([e.start(input), e.start({ ...input, request_id: "different" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    await e.tick(); expect(p.dispatch).toHaveBeenCalledTimes(1);
  }));
});

describe("uncertain dispatch, callbacks and recovery", () => {
  it.each(["ElevenLabs", "Twilio"])("keeps polling and reserving budget when %s ends without a final price", async missing => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); await e.tick();
    const task = e.require(id);
    const initial = conversation(task); initial.metadata.cost_fiat = 0.01;
    if (missing === "ElevenLabs") initial.status = "processing";
    const phone = { ...(await p.call(task)), status: missing === "Twilio" ? "in-progress" as const : "completed" as const, price: "-0.014" };
    applyConversation(task, initial, e.store.nextObservation());
    applyTwilio(task, phone, e.store.nextObservation()); e.store.put(task);
    expect(e.store.used("2026-10")).toBe(400000);

    const finished = { ...initial, status: "done" as const, metadata: { ...initial.metadata, cost_fiat: missing === "ElevenLabs" ? null : 0.01 } };
    p.conversation.mockResolvedValue(finished);
    p.call.mockResolvedValue({ ...phone, status: "completed", price: missing === "Twilio" ? null : "-0.014" });
    await e.reconcile(id);
    expect.soft(e.store.used("2026-10")).toBe(400000);
    expect.soft(e.view(e.require(id)).cost).toMatchObject({ status: "unsettled" });
    expect.soft(e.require(id).nextCheck).toBe(NOW + 60000);
    e.config.budget.fixedMonthlyUsd = 9.5;
    await expect(e.start({ ...input, request_id: "after-final-price" })).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });

    // A later terminal response supplies the missing price and releases the allowance.
    p.conversation.mockResolvedValue({ ...finished, metadata: { ...finished.metadata, cost_fiat: 0.01 } });
    p.call.mockResolvedValue({ ...phone, status: "completed", price: "-0.014" });
    await e.reconcile(id);
    expect(e.store.used("2026-10")).toBe(24000);
    expect(e.view(e.require(id)).cost).toMatchObject({ status: "provider_reported" });
    expect(e.require(id).nextCheck).toBe(e.require(id).expires);

    // Subsequent null prices do not erase terminal price evidence already obtained.
    p.conversation.mockResolvedValue({ ...finished, metadata: { ...finished.metadata, cost_fiat: null } });
    p.call.mockResolvedValue({ ...phone, status: "completed", price: null });
    await e.reconcile(id);
    expect(e.store.used("2026-10")).toBe(24000);
    expect(e.view(e.require(id)).cost).toMatchObject({ status: "provider_reported" });
    await expect(e.start({ ...input, request_id: "after-final-price" })).resolves.toMatchObject({ telephone_status: "pending" });
  }));
  it.each(["processing", "done"] as const)("does not let an older %s callback lower settled spending or admit another call", async staleStatus => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); await e.tick();
    const task = e.require(id);
    applyTwilio(task, { ...(await p.call(task)), status: "completed", price: "-0.014" }, e.store.nextObservation()); e.store.put(task);
    const final = conversation(task); final.metadata.cost_fiat = 1; final.analysis!.transcript_summary = "Final";
    const old = structuredClone(final); old.status = staleStatus; old.metadata.cost_fiat = 0.01; old.analysis!.transcript_summary = "Older summary";
    let release!: (v: typeof old) => void;
    p.conversation.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(final);
    const stale = e.callback("conv_test"); await e.callback("conv_test"); release(old); await stale;
    expect.soft(e.store.used("2026-10")).toBe(1014000); expect(e.require(id).summary).toBe("Final");
    e.config.budget.fixedMonthlyUsd = 8.8;
    await expect(e.start({ ...input, request_id: "after-stale-callback" })).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
  }));
  it("keeps the allowance reserved when only provisional provider prices exist", async () => scenario(async e => {
    const task = e.require(idOf(await e.start(input)));
    const c = conversation(task); c.status = "processing"; c.metadata.cost_fiat = 0.01;
    applyConversation(task, c, 1); task.twilioCostMicros = 14000; e.store.put(task);
    expect(e.store.used("2026-10")).toBe(400000);
  }));
  it("never redials an ambiguous timeout, including after restart", async () => scenario(async (e, p, advance) => {
    p.dispatch.mockRejectedValueOnce(new Error("timeout"));
    const id = idOf(await e.start(input)); await e.tick(); expect(e.require(id).telephone).toBe("dispatch_unknown");
    advance(15000); const restarted = new CallEngine(e.store, p, cfg, () => NOW + 15000); await restarted.tick();
    expect(p.dispatch).toHaveBeenCalledTimes(1); expect(e.store.used("2026-10")).toBe(400000);
    await expect(e.start({ ...input, request_id: "other" })).rejects.toMatchObject({ code: "CALL_IN_PROGRESS" });
  }));
  it("recovers a crash after the dispatch marker without sending", async () => scenario(async (e, p) => {
    const t = e.require(idOf(await e.start(input))); t.telephone = "dispatching"; e.store.put(t);
    await e.tick(); expect(p.dispatch).not.toHaveBeenCalled(); expect(e.require(t.id).telephone).toBe("dispatch_unknown");
  }));
  it("merges callbacks before the outbound response and handles duplicate events", async () => scenario(async (e, p) => {
    const id = idOf(await e.start(input));
    p.dispatch.mockImplementationOnce(async t => {
      p.conversation.mockResolvedValue(conversation(t)); await e.callback("conv_test");
      return { success: true, message: "ok", conversation_id: "conv_test", callSid: "CA" + "3".repeat(32) };
    });
    await e.tick(); await e.callback("conv_test");
    expect(e.require(id).outcome).toBe("voicemail_attempted"); expect(e.require(id).transcript).toHaveLength(2); expect(p.dispatch).toHaveBeenCalledTimes(1);
  }));
  it("rejects callback identity mismatches", async () => scenario(async (e, p) => {
    const t = e.require(idOf(await e.start(input))); const c = conversation(t); c.metadata.phone_call!.external_number = "+12125550123"; p.conversation.mockResolvedValue(c);
    await expect(e.callback("conv_test")).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" }); expect(e.require(t.id).conversationId).toBeUndefined();
  }));
  it("does not infer a successful task from a completed call", async () => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); await e.tick();
    p.call.mockImplementation(async t => ({ sid: t.callSid!, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: t.to, status: "completed", price: "-0.014", price_unit: "USD", start_time: null, duration: "20" }));
    p.conversation.mockRejectedValueOnce(new Error("analysis unavailable"));
    await e.reconcile(id); expect(e.require(id).telephone).toBe("completed"); expect(e.require(id).outcome).toBe("pending");
  }));
  it("preserves uncertainty if a success response has no provider IDs", async () => scenario(async (e, p) => {
    p.dispatch.mockResolvedValueOnce({ success: true, message: "ok", conversation_id: null, callSid: null });
    const id = idOf(await e.start(input)); await e.tick(); expect(e.require(id).telephone).toBe("dispatch_unknown");
  }));
});

describe("cancellation and enforced duration", () => {
  it("schedules the next active check without spinning on deferred background tasks", async () => scenario(async e => {
    const oldId = idOf(await e.start(input)); await e.cancel(oldId);
    const old = e.require(oldId); old.nextCheck = NOW - 1000; e.store.put(old);
    const activeId = idOf(await e.start({ ...input, request_id: "active-priority" }));
    const active = e.require(activeId); active.nextCheck = NOW + 15000; e.store.put(active);
    expect(e.store.due(NOW)).toHaveLength(0); expect(e.store.nextAlarm()).toBe(NOW + 15000);
  }));
  it("runs the active watchdog before terminal-call recovery and defers that background work", async () => scenario(async (e, p) => {
    const oldId = idOf(await e.start(input)); await e.cancel(oldId);
    const old = e.require(oldId); old.telephone = "completed"; old.callSid = "CA" + "4".repeat(32); old.nextCheck = NOW - 1000; e.store.put(old);
    const id = idOf(await e.start({ ...input, request_id: "active-watchdog" }));
    const active = e.require(id); active.telephone = "in-progress"; active.callSid = "CA" + "3".repeat(32); active.conversationId = "conv_test"; active.deadline = NOW - 1; e.store.put(active);
    let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; });
    p.call.mockImplementation(async t => {
      if (t.id === oldId) await delayed;
      return { sid: t.callSid!, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: t.to, status: t.id === oldId ? "completed" : "in-progress", price: null, price_unit: "USD", start_time: null, duration: "30" };
    });
    const work = e.tick(); await new Promise(resolve => setTimeout(resolve, 0));
    expect.soft(p.terminate).toHaveBeenCalledTimes(1);
    expect.soft(p.call.mock.calls.some(([t]) => t.id === oldId)).toBe(false);
    release(); await work;
  }));
  it("still terminates a known Twilio call if ElevenLabs is unavailable", async () => scenario(async (e, p, advance) => {
    const id = idOf(await e.start(input)); await e.tick();
    const task = e.require(id); delete task.conversationId; e.store.put(task);
    p.findConversation.mockRejectedValue(new Error("ElevenLabs offline"));
    advance(240000); await e.reconcile(id); expect(p.terminate).toHaveBeenCalledTimes(1);
  }));
  it("does not dial stale pending work after a delayed alarm", async () => scenario(async (e, p, advance) => {
    const id = idOf(await e.start(input)); advance(61000); await e.tick();
    expect(p.dispatch).not.toHaveBeenCalled(); expect(e.require(id).telephone).toBe("not_dispatched");
  }));
  it("cancels pending tasks without ever contacting a dial endpoint", async () => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); const result = await e.cancel(id); await e.tick();
    expect(result.termination_confirmed).toBe(true); expect(result.telephone_status).toBe("not_dispatched"); expect(e.store.used("2026-10")).toBe(0); expect(p.dispatch).not.toHaveBeenCalled();
  }));
  it("does not claim termination from a successful update alone", async () => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); await e.tick(); const result = await e.cancel(id);
    expect(p.terminate).toHaveBeenCalledTimes(1); expect(result.termination_confirmed).toBe(false); expect(e.require(id).lastError?.code).toBe("TERMINATION_UNCONFIRMED");
  }));
  it("persistent watchdog terminates at the duration plus ringing deadline", async () => scenario(async (e, p, advance) => {
    const id = idOf(await e.start(input)); await e.tick(); advance(240000); await e.tick();
    expect(p.terminate).toHaveBeenCalledTimes(1); expect(e.require(id).cancelRequested).toBe(true);
  }));
  it("retains cancellation intent while dispatch identity is unknown", async () => scenario(async (e, p) => {
    p.dispatch.mockRejectedValueOnce(new Error("timeout")); const id = idOf(await e.start(input)); await e.tick(); await e.cancel(id);
    expect(e.require(id).cancelRequested).toBe(true); expect(p.terminate).not.toHaveBeenCalled();
    const t = e.require(id); p.findConversation.mockResolvedValue(conversation(t)); await e.reconcile(id); expect(p.terminate).toHaveBeenCalledTimes(1);
  }));
});

describe("retention, pagination and conversation outcomes", () => {
  it("rejects expired duplicate requests even if the purge alarm has not run", async () => scenario(async (e, p, advance) => {
    const id = idOf(await e.start(input)); await e.cancel(id);
    const task = e.require(id); task.summary = "Private result"; task.confirmation = "Private confirmation"; e.store.put(task);
    advance(RETENTION);
    await expect(e.start(input)).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
    expect(p.dispatch).not.toHaveBeenCalled();
  }));
  it("purges content at 30 days and rejects ancient retry keys", async () => scenario(async (e, _p, advance) => {
    const id = idOf(await e.start(input)); await e.cancel(id); advance(RETENTION); await e.tick();
    expect(e.store.get(id)).toBeUndefined(); expect(e.store.byRequest(await digest(input.request_id))).toBe("expired");
    await expect(e.start(input)).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  }));
  it("purges unresolved calls too, while blocking new calls for reconciliation", async () => scenario(async (e, p, advance) => {
    p.dispatch.mockRejectedValueOnce(new Error("timeout")); const id = idOf(await e.start(input)); await e.tick(); advance(RETENTION);
    await e.tick(); expect(e.store.get(id)).toBeUndefined();
    await expect(e.start({ ...input, request_id: "later" })).rejects.toMatchObject({ code: "RETENTION_UNRESOLVED" });
  }));
  it("does not reduce watchdog retry frequency after a day of provider failures", async () => scenario(async (e, p, advance) => {
    p.dispatch.mockRejectedValueOnce(new Error("timeout")); const id = idOf(await e.start(input)); await e.tick(); advance(DAY + 1); await e.reconcile(id);
    expect(e.require(id).nextCheck).toBe(NOW + DAY + 1 + 15000);
  }));
  it.each(["voicemail_attempted", "delivered_to_person", "needs_user_input", "partial"])("preserves %s with explicit evidence limits", async outcome => scenario(async e => {
    const t = e.require(idOf(await e.start(input))); applyConversation(t, conversation(t, outcome), 1); const v = e.view(t, true, 1, 1);
    expect(v.task_outcome).toBe(outcome); expect(v.delivery_verified).toBe(false); expect(v.transcript).toMatchObject({ total: 2, next_offset: null });
  }));
  it("sends fresh context as initiation data without changing the saved agent", async () => scenario(async e => {
    const t = e.require(idOf(await e.start(input))); const body = dispatchBody(t, cfg);
    expect(body.call_recording_enabled).toBe(false); expect(body.telephony_call_config.ringing_timeout_secs).toBe(60);
    expect(body.conversation_initiation_client_data.user_id).toBe(t.id);
    expect(body.conversation_initiation_client_data.conversation_config_override).toEqual({ conversation: { max_duration_seconds: 180 } });
  }));
});
