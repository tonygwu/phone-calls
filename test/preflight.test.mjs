import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cfg } from "./data.ts";

const script = resolve("scripts/preflight.mjs");
for (const variant of ["valid", "invalid", "missing", "auth-failed"]) {
  test(`local preflight: ${variant}`, () => {
    const cwd = mkdtempSync(join(tmpdir(), "phone-preflight-"));
    try {
      mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true }); mkdirSync(join(cwd, "private"));
      writeFileSync(join(cwd, "node_modules/.bin/cf"), `#!${process.execPath}\nconsole.log(JSON.stringify({authenticated:${variant !== "auth-failed"},tokenValid:${variant !== "auth-failed"}}));process.exit(${variant === "auth-failed" ? 1 : 0});`, { mode: 0o700 });
      if (variant !== "missing") writeFileSync(join(cwd, "private/service-config.json"), JSON.stringify(variant === "invalid" ? {} : cfg));
      const result = spawnSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), script], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, ELEVENLABS_API_KEY: "synthetic", TWILIO_ACCOUNT_SID: "synthetic", TWILIO_AUTH_TOKEN: "synthetic", CLOUDFLARE_API_TOKEN: "synthetic" } });
      const data = JSON.parse(result.stdout);
      if (variant === "invalid") {
        assert.equal(result.status, 2); assert.equal(data.service_config_valid, false); assert.ok(data.config_issues.some(issue => issue.path === "publicOrigin"));
      } else if (variant === "auth-failed") {
        assert.equal(result.status, 2); assert.equal(data.cloudflare_authenticated, false);
      } else {
        assert.equal(result.status, 0); assert.equal(data.service_config_valid, variant === "missing" ? null : true);
      }
      assert.equal(data.calls_placed_by_this_check, 0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("synthetic provider boundary refuses outbound dispatch to an unrelated host", async () => {
  const { runtimeProvider } = await import("./runtime-provider.ts");
  await assert.rejects(runtimeProvider()(new Request("https://unexpected.example.invalid/v1/convai/twilio/outbound-call", { method: "POST", body: JSON.stringify({ agent_id: cfg.elevenAgentId, agent_phone_number_id: cfg.elevenPhoneId, to_number: cfg.selfNumber, conversation_initiation_client_data: { user_id: "synthetic" } }) })), /Unexpected outbound request/);
});
