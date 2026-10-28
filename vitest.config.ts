import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

import { cfg } from "./test/data";
import { runtimeProvider } from "./test/runtime-provider";

export default defineConfig({
  plugins: [cloudflareTest({
    main: "./src/index.ts",
    miniflare: {
      compatibilityDate: "2026-10-24", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { CALLS: { className: "CallLedger", useSQLite: true } },
      bindings: { SERVICE_CONFIG: JSON.stringify(cfg), ELEVENLABS_API_KEY: "synthetic-runtime-key", ELEVENLABS_WEBHOOK_SECRET: "synthetic-webhook-secret", TWILIO_AUTH_TOKEN: "synthetic-runtime-token" },
      outboundService: runtimeProvider(),
    },
  })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000, reporters: ["default"] },
});
