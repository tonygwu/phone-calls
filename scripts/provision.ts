import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { agentDefinition } from "../src/agent";
import { configSchema } from "../src/config";
import { canonical, digest } from "../src/contracts";
import { setupSchema } from "./setup-config";

const mode = process.argv[2];
if (!["prepare", "apply"].includes(mode)) throw new Error("Usage: provision.ts prepare|apply. Read docs/DEPLOYMENT.md first.");
const setup = setupSchema.parse(JSON.parse(readFileSync("private/setup.json", "utf8")));
mkdirSync("private", { recursive: true, mode: 0o700 });
const write = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const host = new URL(setup.publicOrigin).hostname;
const access = {
  name: "Phone calls MCP", type: "self_hosted", domain: host, session_duration: "24h",
  oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true, allowed_uris: setup.oauthRedirectUris }, grant: { access_token_lifetime: "15m", session_duration: "336h" } },
  policies: [{ name: "Owner only", decision: "allow", include: [{ email: { email: setup.ownerEmail } }] }],
};
const bypasses = ["/webhooks/elevenlabs", "/webhooks/twilio/inbound"].map(path => ({ name: `Phone calls callback ${path}`, type: "self_hosted", domain: host + path, policies: [{ name: "Provider signature verified by Worker", decision: "bypass", include: [{ everyone: {} }] }] }));
const agent = agentDefinition(setup.voiceId);
const plan = { setup, access, bypasses, agent, number_routing: { VoiceUrl: setup.publicOrigin + "/webhooks/twilio/inbound", VoiceMethod: "POST", VoiceFallbackUrl: "", SmsUrl: "", SmsFallbackUrl: "", SmsApplicationSid: "", VoiceApplicationSid: "" }, live_test: "Separate step; provisioning places no calls." };
const hash = await digest(canonical(plan));
if (mode === "prepare") {
  write("private/provision-plan.json", { hash, plan });
  console.log({ prepared: "private/provision-plan.json", sha256: hash, external_changes: 0 });
  process.exit(0);
}
const review = z.object({ verdict: z.literal("ship"), planSha256: z.literal(hash) }).parse(JSON.parse(readFileSync("private/provision-review.json", "utf8")));
if (!review) throw new Error("Fresh review missing");
const journalPath = "private/provision-journal.json";
const savedJournal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : { planSha256: hash, steps: {} };
if (savedJournal.planSha256 !== hash) throw new Error("Provisioning journal belongs to a different plan. Reconcile existing resources before changing the plan.");
const journal: Record<string, { state: "intent" | "done"; value?: any }> = savedJournal.steps;
async function once<T>(step: string, operation: () => Promise<T>): Promise<T> {
  const previous = journal[step];
  if (previous?.state === "done") return previous.value;
  if (previous) throw new Error(`${step}: previous attempt has an uncertain result. Reconcile externally; do not repeat the mutation.`);
  journal[step] = { state: "intent" }; write(journalPath, { planSha256: hash, steps: journal });
  const value = await operation();
  journal[step] = { state: "done", value }; write(journalPath, { planSha256: hash, steps: journal });
  console.log({ step, state: "done" }); return value;
}
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is missing`); return value; }
const sid = required("TWILIO_ACCOUNT_SID");
if (sid !== setup.twilioAccountSid) throw new Error("Twilio account does not match the reviewed plan.");
const twilioHeaders = { Authorization: `Basic ${Buffer.from(`${sid}:${required("TWILIO_AUTH_TOKEN")}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" };
const elevenHeaders = { "xi-api-key": required("ELEVENLABS_API_KEY"), "Content-Type": "application/json" };
async function request(url: string, headers: Record<string, string>, body?: string) {
  const response = await fetch(url, { headers, method: body === undefined ? "GET" : "POST", body, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Provider HTTP ${response.status}. Check private journal before retrying a mutation.`);
  return response.json() as Promise<any>;
}
async function cfCreate(body: unknown) {
  const result = spawnSync("node_modules/.bin/cf", ["zero-trust", "access", "applications", "create", "--body", JSON.stringify(body)], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: setup.cloudflareAccountId }, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cloudflare application creation failed; inspect account state before retrying.");
  return z.object({ id: z.string(), aud: z.string() }).parse(JSON.parse(result.stdout));
}
// Verify the selected account before provisioning resources.
const account = await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, twilioHeaders);
if (account.sid !== sid || account.status !== "active") throw new Error("The selected Twilio account identity or active status does not match the reviewed plan.");
// Only creates dedicated new resources. Never updates an existing service.
const app = await once("access", () => cfCreate(access));
for (const [i, bypass] of bypasses.entries()) await once(`callback-access-${i}`, () => cfCreate(bypass));
const webhook = await once("eleven-webhook", async () => z.object({ webhook_id: z.string(), webhook_secret: z.string().min(1) }).parse(await request("https://api.elevenlabs.io/v1/workspace/webhooks", elevenHeaders, JSON.stringify({ settings: { auth_type: "hmac", name: "Private phone calls", webhook_url: setup.publicOrigin + "/webhooks/elevenlabs" } }))));
const definition = { ...agent, platform_settings: { ...agent.platform_settings, workspace_overrides: { webhooks: { post_call_webhook_id: webhook.webhook_id, events: ["transcript", "call_initiation_failure"] } } } };
const created = await once("eleven-agent", async () => z.object({ agent_id: z.string() }).parse(await request("https://api.elevenlabs.io/v1/convai/agents/create", elevenHeaders, JSON.stringify(definition))));
const number = await once("twilio-number", async () => z.object({ sid: z.string().regex(/^PN/), account_sid: z.literal(sid), phone_number: z.literal(setup.selectedNumber) }).parse(await request(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, twilioHeaders, new URLSearchParams({ PhoneNumber: setup.selectedNumber, FriendlyName: "Private phone assistant", ...plan.number_routing }).toString())));
const imported = await once("eleven-number", async () => z.object({ phone_number_id: z.string() }).parse(await request("https://api.elevenlabs.io/v1/convai/phone-numbers", elevenHeaders, JSON.stringify({ phone_number: number.phone_number, label: "Private outbound calls", provider: "twilio", sid, token: required("TWILIO_AUTH_TOKEN"), agent_id: null, enable_sms: false, supports_inbound: false, supports_outbound: true }))));
// Import may rewrite routing; reapply and verify the rejecting route afterward.
await once("outbound-only-routing", () => request(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${number.sid}.json`, twilioHeaders, new URLSearchParams(plan.number_routing).toString()));
const readback = await request(`https://api.elevenlabs.io/v1/convai/agents/${created.agent_id}`, elevenHeaders);
if (readback.agent_id !== created.agent_id) throw new Error("ElevenLabs readback returned a different agent.");
const { selectedNumber, cloudflareAccountId, oauthRedirectUris, ...baseConfig } = setup;
const serviceConfig = configSchema.parse({ ...baseConfig, accessAudience: app.aud, twilioNumberSid: number.sid, fromNumber: number.phone_number, elevenAgentId: created.agent_id, elevenPhoneId: imported.phone_number_id });
write("private/service-config.json", serviceConfig);
write("private/worker-secrets.json", { SERVICE_CONFIG: JSON.stringify(serviceConfig), ELEVENLABS_API_KEY: required("ELEVENLABS_API_KEY"), TWILIO_AUTH_TOKEN: required("TWILIO_AUTH_TOKEN"), ELEVENLABS_WEBHOOK_SECRET: webhook.webhook_secret });
write("private/agent-readback.json", readback);
console.log({ provisioned: true, deployed: false, calls_placed: 0 });
