import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { CallEngine } from "../src/engine";
import { SqlStore } from "../src/store";
import type { Env } from "../src/config";
import { DAY, RETENTION, startSchema } from "../src/contracts";
import { applyConversation, applyTwilio, correlate, LiveProviders } from "../src/providers";
import { dispatchBody, REMINDER_PROMPT } from "../src/agent";
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

describe("call validation and dispatch", () => {
  it("rejects unsupported numbers and missing essentials", () => {
    expect(startSchema.safeParse({ ...input, recipient: "+14165550123" }).success).toBe(false);
    expect(startSchema.safeParse({ ...input, success_criteria: [] }).success).toBe(false);
  });
  it("accepts the supplied duration and ordinary US destinations", async () => scenario(async (e, p) => {
    const id = idOf(await e.start({ ...input, recipient: "+12125550123", max_duration_seconds: 1900 }));
    expect(e.require(id).duration).toBe(1900);
    await e.tick(); expect(p.dispatch).toHaveBeenCalledTimes(1);
  }));
  it("persists a task and returns before dispatch", async () => scenario(async (e, p) => {
    const result = await e.start(input);
    expect(result.telephone_status).toBe("pending"); expect(p.dispatch).not.toHaveBeenCalled();
    p.dispatch.mockImplementationOnce(async task => {
      expect(e.require(task.id).telephone).toBe("dispatching");
      return { success: true, message: "ok", conversation_id: "conv_test", callSid: "CA" + "3".repeat(32) };
    });
    await e.tick(); expect(p.dispatch).toHaveBeenCalledTimes(1);
  }));
});

describe("uncertain dispatch, callbacks and recovery", () => {
  it.each(["processing", "done"] as const)("does not let an older %s callback replace the final summary", async staleStatus => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); await e.tick();
    const task = e.require(id);
    const final = conversation(task); final.analysis!.transcript_summary = "Final";
    const old = structuredClone(final); old.status = staleStatus; old.analysis!.transcript_summary = "Older summary";
    let release!: (v: typeof old) => void;
    p.conversation.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce(final);
    const stale = e.callback("conv_test"); await e.callback("conv_test"); release(old); await stale;
    expect(e.require(id).summary).toBe("Final");
  }));
  it("never redials an ambiguous timeout, including after restart", async () => scenario(async (e, p, advance) => {
    p.dispatch.mockRejectedValueOnce(new Error("timeout"));
    const id = idOf(await e.start(input)); await e.tick(); expect(e.require(id).telephone).toBe("dispatch_unknown");
    advance(15000); const restarted = new CallEngine(e.store, p, cfg, () => NOW + 15000); await restarted.tick();
    expect(p.dispatch).toHaveBeenCalledTimes(1);
    await expect(e.start({ ...input, request_id: "other" })).resolves.toMatchObject({ telephone_status: "pending" });
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
  it("dispatches accepted work after a delayed alarm", async () => scenario(async (e, p, advance) => {
    const id = idOf(await e.start(input)); advance(61000); await e.tick();
    expect(p.dispatch).toHaveBeenCalledTimes(1); expect(e.require(id).telephone).toBe("queued");
  }));
  it("cancels pending tasks without ever contacting a dial endpoint", async () => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); const result = await e.cancel(id); await e.tick();
    expect(result.termination_confirmed).toBe(true); expect(result.telephone_status).toBe("not_dispatched"); expect(p.dispatch).not.toHaveBeenCalled();
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
  it("purges call content after 30 days and permits new requests", async () => scenario(async (e, _p, advance) => {
    const id = idOf(await e.start(input)); await e.cancel(id); advance(RETENTION); await e.tick();
    expect(e.store.get(id)).toBeUndefined();
    await expect(e.start(input)).resolves.toMatchObject({ telephone_status: "pending" });
  }));
  it("purges unresolved content without blocking later calls", async () => scenario(async (e, p, advance) => {
    p.dispatch.mockRejectedValueOnce(new Error("timeout")); const id = idOf(await e.start(input)); await e.tick(); advance(RETENTION);
    await e.tick(); expect(e.store.get(id)).toBeUndefined();
    await expect(e.start(input)).resolves.toMatchObject({ telephone_status: "pending" });
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
    expect(body.conversation_initiation_client_data.conversation_config_override).toEqual({ agent: { prompt: { prompt: REMINDER_PROMPT } }, conversation: { max_duration_seconds: 180 } });
  }));
});

describe("reliability regressions", () => {
  it.each([401, 403])("reports a dispatch rejected by provider authentication HTTP %s", async status => scenario(async (e, p, advance) => {
    const provider = new LiveProviders({ ELEVENLABS_API_KEY: "synthetic" } as Env, cfg, async () => new Response("private provider body", { status }));
    p.dispatch.mockImplementation(t => provider.dispatch(t));
    const id = idOf(await e.start(input)); await e.tick();
    expect(e.require(id).telephone).toBe("not_dispatched");
    expect(e.require(id).lastError?.code).toBe("DISPATCH_NOT_ACCEPTED");
    expect(p.dispatch).toHaveBeenCalledTimes(1);
    advance(RETENTION); await e.tick();
    await expect(e.start({ ...input, request_id: "after-rejection" })).resolves.toMatchObject({ telephone_status: "pending" });
  }));
  it.each([400, 408, 429, 500])("preserves uncertain dispatch for HTTP %s", async status => scenario(async (e, p) => {
    const provider = new LiveProviders({ ELEVENLABS_API_KEY: "synthetic" } as Env, cfg, async () => new Response(null, { status }));
    p.dispatch.mockImplementation(t => provider.dispatch(t));
    const id = idOf(await e.start(input)); await e.tick();
    expect(e.require(id).telephone).toBe("dispatch_unknown");
  }));
  it("preserves callback evidence despite a conflicting authentication rejection", async () => scenario(async (e, p) => {
    const provider = new LiveProviders({ ELEVENLABS_API_KEY: "synthetic" } as Env, cfg, async () => new Response(null, { status: 401 }));
    p.dispatch.mockImplementation(async t => {
      p.conversation.mockResolvedValue(conversation(t)); await e.callback("conv_test");
      return provider.dispatch(t);
    });
    const id = idOf(await e.start(input)); await e.tick();
    expect(e.require(id).callSid).toBeDefined();
    expect(e.require(id).telephone).not.toBe("not_dispatched");
  }));
  it("settles a completed conversation containing a tool-only turn without message text", async () => scenario(async (e, p) => {
    const id = idOf(await e.start(input)); await e.tick();
    const c = conversation(e.require(id));
    const raw = { ...c, transcript: [...c.transcript, { role: "agent", time_in_call_secs: 20, tool_calls: [{ tool_name: "end_call" }] }] };
    const provider = new LiveProviders({ ELEVENLABS_API_KEY: "synthetic" } as Env, cfg, async () => Response.json(raw));
    p.conversation.mockImplementation(id => provider.conversation(id));
    p.call.mockResolvedValue({ ...(await p.call(e.require(id))), status: "completed", price: "-0.014" });
    await e.reconcile(id);
    expect(e.require(id).lastError).toBeUndefined();
    expect(e.require(id).transcript?.at(-1)?.message).toBeNull();
    expect(e.view(e.require(id)).cost).toMatchObject({ twilio_usd: 0.014, elevenlabs_total_fiat_usd: 0.05 });
    const malformed = { ...raw, transcript: [{ role: "agent", time_in_call_secs: 0, message: 42 }] };
    const bad = new LiveProviders({ ELEVENLABS_API_KEY: "synthetic" } as Env, cfg, async () => Response.json(malformed));
    await expect(bad.conversation("conv_test")).rejects.toMatchObject({ code: "PROVIDER_SCHEMA" });
  }));
});

it("resumes termination when a late callback proves a previously rejected task has a real call", async () => scenario(async (e, p, advance) => {
  const id = idOf(await e.start(input));
  const rejected = e.require(id); rejected.telephone = "not_dispatched"; rejected.outcome = "failed"; rejected.twilioCostMicros = 0; rejected.elevenCostMicros = 0; rejected.cancelRequested = true; rejected.nextCheck = rejected.expires; e.store.put(rejected);
  const c = conversation(rejected); c.status = "in-progress"; c.metadata.cost_fiat = null; p.conversation.mockResolvedValue(c);
  await e.callback(c.conversation_id);
  expect(e.require(id).telephone).toBe("dispatch_unknown");
  expect(e.require(id).twilioCostMicros).toBeUndefined();
  await e.reconcile(id);
  expect(p.terminate).toHaveBeenCalledTimes(1);
  expect(p.dispatch).not.toHaveBeenCalled();
}));
