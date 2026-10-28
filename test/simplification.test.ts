import { describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { CallEngine } from "../src/engine";
import { SqlStore } from "../src/store";
import { configSchema } from "../src/config";
import { LiveProviders } from "../src/providers";
import { RETENTION, type Task } from "../src/contracts";
import { cfg, input, NOW, fakeProviders, conversation } from "./fixtures";

async function scenario(fn: (engine: CallEngine, providers: ReturnType<typeof fakeProviders>, state: DurableObjectState) => Promise<void>) {
  const stub = env.CALLS.get(env.CALLS.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    const providers = fakeProviders();
    await fn(new CallEngine(new SqlStore(state.storage), providers, cfg, () => NOW), providers, state);
  });
}

describe("calls without readiness, duplicate, or spending gates", () => {
  it("accepts configuration without budgets, agent fingerprints, or test acceptance", () => {
    const fields = ["publicOrigin", "accessIssuer", "accessAudience", "ownerEmail", "ownerSubject", "ownerName", "selfNumber", "callbackNumber", "twilioAccountSid", "twilioNumberSid", "fromNumber", "elevenAgentId", "elevenPhoneId", "voiceId"];
    const minimal = Object.fromEntries(fields.map(key => [key, (cfg as Record<string, unknown>)[key]]));
    expect(configSchema.safeParse(minimal).success).toBe(true);
  });

  it("creates and dispatches independent calls for identical concurrent requests", async () => scenario(async (engine, providers) => {
    const calls = await Promise.all([engine.start(input), engine.start(input), engine.start({ ...input, objective: "Another request with the same client label" })]);
    expect(new Set(calls.map(call => call.call_id)).size).toBe(3);
    await engine.tick();
    expect(providers.dispatch).toHaveBeenCalledTimes(3);
  }));

  it("starts through the real provider adapter using only the outbound POST", async () => scenario(async engine => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
      expect(init?.method).toBe("POST");
      return Response.json({ success: true, message: "started", conversation_id: "conv_test", callSid: "CA" + "3".repeat(32) });
    });
    const live = new LiveProviders({ CALLS: env.CALLS, ELEVENLABS_API_KEY: "synthetic-key" }, cfg, fetcher);
    const realEngine = new CallEngine(engine.store, live, cfg, () => NOW);
    const call = await realEngine.start({ ...input, request_id: undefined });
    expect(fetcher).not.toHaveBeenCalled();
    await realEngine.tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(realEngine.require(call.call_id as string).telephone).toBe("queued");
  }));

  it("allows a new call while another dispatch is unresolved", async () => scenario(async (engine, providers) => {
    providers.dispatch.mockRejectedValueOnce(new Error("synthetic provider timeout"));
    const first = await engine.start(input); await engine.tick();
    expect(engine.require(first.call_id as string).telephone).toBe("dispatch_unknown");
    const second = await engine.start(input);
    expect(second.call_id).not.toBe(first.call_id);
    await engine.tick();
    expect(providers.dispatch).toHaveBeenCalledTimes(2);
  }));

  it("checks overlapping calls without waiting for a slow provider response", async () => scenario(async (engine, providers) => {
    const first = engine.require((await engine.start(input)).call_id as string);
    const second = engine.require((await engine.start(input)).call_id as string);
    for (const [index, task] of [first, second].entries()) {
      task.telephone = "in-progress"; task.callSid = "CA" + String(index + 3).repeat(32); task.deadline = NOW - 1; engine.store.put(task);
    }
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const original = providers.call.getMockImplementation()!;
    providers.call.mockImplementation(async task => { if (task.id === first.id) await delayed; return original(task); });
    const tick = engine.tick(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(providers.terminate).toHaveBeenCalledWith(expect.objectContaining({ id: second.id }), "in-progress");
    release(); await tick;
  }));

  it("finishes result collection without waiting for provider prices", async () => scenario(async (engine, providers) => {
    const call = await engine.start(input); await engine.tick();
    const task = engine.require(call.call_id as string);
    const result = conversation(task); result.metadata.cost_fiat = null;
    providers.conversation.mockResolvedValue(result);
    providers.call.mockResolvedValue({ ...(await providers.call(task)), status: "completed", price: null });
    await engine.reconcile(task.id);
    expect(engine.require(task.id).nextCheck).toBe(task.expires);
  }));

  it("migrates old call history and removes obsolete admission tables", async () => scenario(async (_engine, providers, state) => {
    const sql = state.storage.sql;
    sql.exec("DROP TABLE calls");
    sql.exec("CREATE TABLE calls (id TEXT PRIMARY KEY, request_hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, month TEXT NOT NULL, active INTEGER NOT NULL, next_check INTEGER NOT NULL, allowance INTEGER NOT NULL, body TEXT NOT NULL)");
    for (const table of ["expired_requests", "monthly_charges", "safety_blocks"]) sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (legacy TEXT)`);
    const legacy = { id: crypto.randomUUID(), requestId: "old-request", hash: "old-hash", input, to: cfg.selfNumber, created: NOW, expires: NOW + RETENTION, month: "2026-10", duration: 180, telephone: "completed", outcome: "voicemail_attempted", cancelRequested: false, nextCheck: NOW + RETENTION, attempts: 1, reservationMicros: 400000, transcript: [{ role: "agent", message: "Historical transcript", time_in_call_secs: 0 }] } as Task;
    const other = { ...legacy, id: crypto.randomUUID(), requestId: "other-request" };
    for (const task of [legacy, other]) sql.exec("INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", task.id, task.requestId, NOW, task.expires, "2026-10", 0, task.nextCheck, 400000, JSON.stringify(task));
    const store = new SqlStore(state.storage);
    for (const task of [legacy, other]) expect(store.get(task.id)).toEqual(task);
    expect(sql.exec<{ name: string }>("PRAGMA table_info(calls)").toArray().map(row => row.name)).toEqual(["id", "created", "expires", "active", "next_check", "body"]);
    expect(sql.exec("SELECT name FROM sqlite_master WHERE name IN ('expired_requests','monthly_charges','safety_blocks')").toArray()).toEqual([]);
    const engine = new CallEngine(store, providers, cfg, () => NOW);
    const first = await engine.start(input); const second = await engine.start(input);
    expect(first.call_id).not.toBe(second.call_id);
    expect(new SqlStore(state.storage).list(undefined, 10)).toHaveLength(4);
    // Expiring an unresolved task deletes its content without blocking calls.
    const unresolved = engine.require(first.call_id as string); unresolved.expires = NOW - 1; store.put(unresolved);
    store.purge(NOW);
    expect(store.get(unresolved.id)).toBeUndefined();
    await expect(engine.start(input)).resolves.toMatchObject({ telephone_status: "pending" });
  }));
});
