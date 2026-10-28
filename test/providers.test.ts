import { expect, it } from "vitest";
import { LiveProviders, dispatchResponse, conversationSchema } from "../src/providers";
import { cfg } from "./fixtures";
import { type Env } from "../src/config";

it("fails loud on missing dispatch telemetry", () => {
  expect(dispatchResponse.safeParse({ success: true, message: "ok" }).success).toBe(false);
  expect(conversationSchema.safeParse({ status: "done" }).success).toBe(false);
});

// Unlike an injected vi.fn, native Workers fetch validates its receiver.
it("streams provider audio through the default Workers fetch implementation", async () => {
  const p = new LiveProviders({ ELEVENLABS_API_KEY: "synthetic-runtime-key" } as Env, cfg);
  const response = await p.audio("runtime-fetch-probe");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([73, 68, 51]);
});

it("does not follow provider redirects or treat them as a definitive dispatch rejection", async () => {
  const p = new LiveProviders({ ELEVENLABS_API_KEY: "synthetic-runtime-key" } as Env, cfg);
  await expect(p.audio("runtime-redirect-probe")).rejects.toMatchObject({ code: "PROVIDER_UNCERTAIN", message: "Provider returned HTTP 302." });
});
