import { expect, it, vi } from "vitest";
import { createMcpHandler } from "agents/mcp/server";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createServer } from "../src/mcp";
import { input } from "./fixtures";

it("exposes four tools and routes independent start requests through the real HTTP MCP handler", async () => {
  const invoke = vi.fn(async () => ({ ok: true, data: { ready: false } }));
  const handler = createMcpHandler(() => createServer(invoke));
  async function rpc(method: string, params: unknown) {
    const ctx = createExecutionContext();
    const res = await handler(new Request("https://calls.example.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), {}, ctx);
    const text = await res.text(); await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    if (res.headers.get("Content-Type")?.includes("text/event-stream")) {
      const data = text.split("\n").find(line => line.startsWith("data: "));
      if (!data) throw new Error("Missing MCP result event");
      return JSON.parse(data.slice(6));
    }
    return JSON.parse(text);
  }
  const list = await rpc("tools/list", {});
  expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["phone_calls_start_call", "phone_calls_get_call", "phone_calls_list_calls", "phone_calls_cancel_call"]);
  expect(list.result.tools[0].annotations.idempotentHint).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  await rpc("tools/call", { name: "phone_calls_start_call", arguments: input });
  expect(invoke).toHaveBeenCalledWith("start", input);
});
