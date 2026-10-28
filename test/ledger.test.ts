import { expect, it } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { input } from "./fixtures";
import { SqlStore } from "../src/store";

it("executes the production ledger routes, durable alarms, provider parsing and final cost settlement", async () => {
  const stub = env.CALLS.get(env.CALLS.newUniqueId());
  async function post(path: string, body: unknown = {}) {
    const res = await stub.fetch(`https://ledger/${path}`, { method: "POST", body: JSON.stringify(body) });
    const result = await res.json() as any;
    expect(res.status).toBe(200); expect(result.ok).toBe(true); return result.data;
  }
  const first = await post("start", { ...input, request_id: "cancel-before-dispatch" });
  expect(first.telephone_status).toBe("pending");
  expect((await post("cancel", { call_id: first.call_id })).telephone_status).toBe("not_dispatched");
  const started = await post("start", input);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect((await post("get", { call_id: started.call_id })).telephone_status).toBe("queued");
  expect((await post("callback", { conversation_id: started.call_id })).persisted).toBe(true);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const completed = await post("get", { call_id: started.call_id, include_transcript: true });
  expect(completed.telephone_status).toBe("completed");
  expect(completed.cost).toMatchObject({ twilio_usd: 0.014, elevenlabs_total_fiat_usd: 0.05 });
  expect(completed.transcript.turns).toEqual([{ role: "agent", time_in_call_secs: 0, message: null, tool_calls: [{ tool_name: "end_call" }] }]);
  const page = await post("list", { limit: 1 });
  expect(page.calls).toHaveLength(1); expect(page.next_cursor).toBeTypeOf("string");
  const next = await post("list", { limit: 1, cursor: page.next_cursor });
  expect(next.calls).toHaveLength(1); expect(next.next_cursor).toBeNull();
  expect(next.calls[0].call_id).not.toBe(page.calls[0].call_id);
  await runInDurableObject(stub, async (_instance, state) => {
    const store = new SqlStore(state.storage);
    expect(await state.storage.getAlarm()).toBe(store.nextAlarm());
  });
});
