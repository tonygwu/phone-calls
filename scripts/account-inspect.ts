import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";

function required(name: string) { const v = process.env[name]; if (!v) throw new Error(`${name} is missing from .dev.vars`); return v; }
const sid = z.string().regex(/^AC[a-f0-9]{32}$/i).parse(required("TWILIO_ACCOUNT_SID"));
mkdirSync("private/account-evidence", { recursive: true, mode: 0o700 });
async function inspect(name: string, url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  // Preserve the entire raw response for identity inspection, not just liveness.
  writeFileSync(`private/account-evidence/${name}.json`, raw, { mode: 0o600 });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}; private raw evidence saved.`);
  return JSON.parse(raw);
}
const auth = { Authorization: `Basic ${Buffer.from(`${sid}:${required("TWILIO_AUTH_TOKEN")}`).toString("base64")}` };
const results = await Promise.allSettled([
  inspect("twilio-account", `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, auth),
  inspect("twilio-balance", `https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, auth),
  inspect("elevenlabs-user", "https://api.elevenlabs.io/v1/user", { "xi-api-key": required("ELEVENLABS_API_KEY") }),
  inspect("elevenlabs-subscription", "https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": required("ELEVENLABS_API_KEY") }),
]);
let failed = 0;
for (const [index, r] of results.entries()) {
  try {
    if (r.status === "rejected") { failed++; console.error({ provider_check: index, error: String(r.reason) }); }
    else if (index === 0) {
      const a = z.object({ sid: z.literal(sid), status: z.string(), type: z.string(), friendly_name: z.string() }).parse(r.value);
      console.log({ provider: "Twilio", selected_account_sid: sid, served_account_sid: a.sid, status: a.status, type: a.type, name: a.friendly_name });
    } else if (index === 1) {
      const a = z.object({ account_sid: z.literal(sid), balance: z.string(), currency: z.string() }).parse(r.value);
      console.log({ provider: "Twilio", balance: a.balance, currency: a.currency });
    } else if (index === 2) {
      const a = z.object({ user_id: z.string().min(1), workspace_id: z.string().min(1), first_name: z.string().min(1) }).parse(r.value);
      console.log({ provider: "ElevenLabs", user_id: a.user_id, workspace_id: a.workspace_id, first_name: a.first_name });
    } else {
      const a = z.object({ status: z.string(), tier: z.string(), character_count: z.number(), character_limit: z.number() }).parse(r.value);
      console.log({ provider: "ElevenLabs", status: a.status, tier: a.tier, available_credits: a.character_limit - a.character_count });
    }
  } catch {
    failed++;
    console.error({ provider_check: index, error: "Account response failed identity/schema validation; inspect the private raw evidence.", failure_category: "account_response" });
  }
}
console.log({ attempted: results.length, succeeded: results.length - failed, failed, failure_category: failed ? "account_read_or_response" : null });
if (failed) process.exitCode = 1;
