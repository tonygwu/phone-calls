import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "phone-calls-mcp",
    entrypoint,
    compatibilityDate: "2026-10-24",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    // Deployment requires an explicit hostname and an already configured Access app.
    domains: process.env.PHONE_CALLS_HOSTNAME ? [process.env.PHONE_CALLS_HOSTNAME] : [],
    exports: { CallLedger: exports.durableObject({ storage: "sqlite" }) },
    env: {
      CALLS: bindings.durableObject({ worker: "phone-calls-mcp", exportName: "CallLedger" }),
      SERVICE_CONFIG: bindings.secret(),
      ELEVENLABS_API_KEY: bindings.secret(),
      ELEVENLABS_WEBHOOK_SECRET: bindings.secret(),
      TWILIO_AUTH_TOKEN: bindings.secret(),
      ELEVENLABS_SIP_PASSWORD: bindings.secret(),
      ELEVENLABS_INITIATION_SECRET: bindings.secret(),
    },
    observability: { enabled: false },
  },
});
