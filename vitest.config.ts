import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({
    main: "./src/index.ts",
    miniflare: {
      compatibilityDate: "2026-10-24", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { CALLS: { className: "CallLedger", useSQLite: true } },
      // Exercise native Workers fetch without sending test credentials externally.
      outboundService: async request => {
        if (!["https://api.elevenlabs.io/v1/convai/conversations/runtime-fetch-probe/audio", "https://api.elevenlabs.io/v1/convai/conversations/runtime-redirect-probe/audio"].includes(request.url) || request.method !== "GET" || request.headers.get("xi-api-key") !== "synthetic-runtime-key") throw new Error("Unexpected outbound request in test");
        if (request.url.includes("runtime-redirect-probe")) return new Response(null, { status: 302, headers: { Location: "https://unexpected.example.invalid/" } });
        return new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });
      },
    },
  })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000, reporters: ["default"] },
});
