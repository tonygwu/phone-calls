import { describe, expect, it, vi } from "vitest";
import { LiveProviders, dispatchResponse, conversationSchema } from "../src/providers";
import { agentDefinition, agentHash } from "../src/agent";
import { cfg, NOW } from "./fixtures";
import { configSchema, type Env } from "../src/config";

async function setup(overrides: Record<string, unknown> = {}) {
  const agent = { ...agentDefinition(cfg.voiceId), agent_id: cfg.elevenAgentId };
  const c = { ...cfg, agentConfigHash: await agentHash(agent) };
  const responses: Record<string, unknown> = {
    [`/v1/convai/agents/${cfg.elevenAgentId}`]: agent,
    [`/v1/convai/phone-numbers/${cfg.elevenPhoneId}`]: { phone_number_id: cfg.elevenPhoneId, phone_number: cfg.fromNumber, provider: "twilio", assigned_agent: null },
    [`/2010-04-01/Accounts/${cfg.twilioAccountSid}.json`]: { sid: cfg.twilioAccountSid, status: "active", type: "Full" },
    [`/2010-04-01/Accounts/${cfg.twilioAccountSid}/IncomingPhoneNumbers/${cfg.twilioNumberSid}.json`]: { sid: cfg.twilioNumberSid, account_sid: cfg.twilioAccountSid, phone_number: cfg.fromNumber, voice_url: cfg.publicOrigin + "/webhooks/twilio/inbound", voice_method: "POST", voice_application_sid: "", voice_fallback_url: "", trunk_sid: "", sms_url: "", sms_application_sid: "", sms_fallback_url: "" },
    "/v1/user/subscription": { status: "active", tier: "creator", character_count: 100, character_limit: 100000 },
    [`/2010-04-01/Accounts/${cfg.twilioAccountSid}/Balance.json`]: { account_sid: cfg.twilioAccountSid, currency: "USD", balance: "10.0" },
    [`/v2/Voice/Numbers/${encodeURIComponent(cfg.selfNumber)}`]: { destination_number: cfg.selfNumber, origination_number: cfg.fromNumber, country: "United States", iso_country: "US", price_unit: "USD", outbound_call_prices: [{ current_price: "0.014", base_price: "0.014", origination_prefixes: ["ALL"] }], inbound_call_price: null },
    ...overrides,
  };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (!(path in responses)) throw new Error("Unexpected provider endpoint " + path);
    return Response.json(responses[path]);
  }) as unknown as typeof fetch;
  const env = { ELEVENLABS_API_KEY: "test-key", ELEVENLABS_WEBHOOK_SECRET: "test-webhook-secret", TWILIO_AUTH_TOKEN: "test-token" } as Env;
  return { p: new LiveProviders(env, c, fetcher), responses, c, fetcher };
}
describe("provider preflight and schemas", () => {
  it("accepts provider-materialized empty analysis metadata without mutating its input", async () => {
    const approved = agentDefinition(cfg.voiceId);
    const readback = structuredClone(approved);
    for (const field of Object.values(readback.platform_settings.data_collection)) Object.assign(field, { non_sensitive_value: null });
    expect(await agentHash(readback)).toBe(await agentHash(approved));
    for (const field of Object.values(readback.platform_settings.data_collection)) expect(field).toHaveProperty("non_sensitive_value", null);
  });
  it.each(["nonempty", "other_field", "workflow"])("retains hash protection for changed analysis/configuration: %s", async variant => {
    const approved = agentDefinition(cfg.voiceId);
    const readback = structuredClone(approved);
    if (variant === "nonempty") Object.assign(readback.platform_settings.data_collection.outcome, { non_sensitive_value: "changed" });
    if (variant === "other_field") Object.assign(readback.platform_settings.data_collection.outcome, { other_provider_field: null });
    if (variant === "workflow") Object.assign(readback, { workflow: { nodes: { additional: { type: "tool" } } } });
    expect(await agentHash(readback)).not.toBe(await agentHash(approved));
  });
  it("accepts standing cost allowances without renewal timestamps", () => {
    const { verifiedAt: _verified, expiresAt: _expires, ...budget } = cfg.budget;
    expect(configSchema.parse({ ...cfg, budget }).budget).toEqual(budget);
  });
  it("checks live rates and credits after legacy allowance timestamps expire", async () => {
    const { p, c, fetcher } = await setup();
    c.budget = { ...c.budget, verifiedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-02T00:00:00Z" };
    const q = await p.preflight(cfg.selfNumber, 180, NOW);
    expect(q).toMatchObject({ checkedAt: NOW, reservationMicros: 362000, creditsAvailable: 99900, twilioBalanceUsd: 10 });
    expect(fetcher).toHaveBeenCalledTimes(7);
    const pricing = vi.mocked(fetcher).mock.calls.map(([url]) => new URL(String(url))).find(url => url.hostname === "pricing.twilio.com");
    expect(pricing?.pathname).toBe(`/v2/Voice/Numbers/${encodeURIComponent(cfg.selfNumber)}`);
    expect(pricing?.searchParams.get("OriginationNumber")).toBe(cfg.fromNumber);
  });
  it("checks account, agent, route, live credits, price and standing allowance", async () => {
    const { p, fetcher } = await setup(); const q = await p.preflight(cfg.selfNumber, 180, NOW);
    expect(q).toMatchObject({ accountSid: cfg.twilioAccountSid, agentId: cfg.elevenAgentId, model: "gpt-4.1-mini", creditsAvailable: 99900, twilioBalanceUsd: 10, reservationMicros: 362000 });
    const urls = vi.mocked(fetcher).mock.calls.map(([url]) => new URL(String(url)));
    const pricing = urls.find(url => url.hostname === "pricing.twilio.com");
    expect(pricing?.searchParams.get("OriginationNumber")).toBe(cfg.fromNumber);
  });
  it.each(["account", "agent", "sms", "credits", "price"])("blocks unsafe or unknown %s before spending", async variant => {
    const { p, responses } = await setup();
    if (variant === "account") (responses[`/2010-04-01/Accounts/${cfg.twilioAccountSid}.json`] as any).sid = "different";
    if (variant === "agent") (responses[`/v1/convai/agents/${cfg.elevenAgentId}`] as any).conversation_config.agent.prompt.llm = "different";
    if (variant === "sms") (responses[`/2010-04-01/Accounts/${cfg.twilioAccountSid}/IncomingPhoneNumbers/${cfg.twilioNumberSid}.json`] as any).sms_url = "https://example.com/sms";
    if (variant === "credits") (responses["/v1/user/subscription"] as any).character_limit = 100;
    if (variant === "price") (responses[`/v2/Voice/Numbers/${encodeURIComponent(cfg.selfNumber)}`] as any).outbound_call_prices = [{}];
    await expect(p.preflight(cfg.selfNumber, 180, NOW)).rejects.toThrow();
  });
  it.each(["destination", "origin", "missing_origin", "empty_prices", "multiple_prices", "missing_price", "negative", "nonfinite", "missing_prefixes"])("rejects unverified destination pricing: %s", async variant => {
    const { p, responses } = await setup();
    const price = responses[`/v2/Voice/Numbers/${encodeURIComponent(cfg.selfNumber)}`] as any;
    if (variant === "destination") price.destination_number = "+12125550199";
    if (variant === "origin") price.origination_number = "+12125550199";
    if (variant === "missing_origin") delete price.origination_number;
    if (variant === "empty_prices") price.outbound_call_prices = [];
    if (variant === "multiple_prices") price.outbound_call_prices.push({ current_price: "0.2", origination_prefixes: ["1"] });
    if (variant === "missing_price") delete price.outbound_call_prices[0].current_price;
    if (variant === "negative") price.outbound_call_prices[0].current_price = "-0.014";
    if (variant === "nonfinite") price.outbound_call_prices[0].current_price = "9".repeat(400);
    if (variant === "missing_prefixes") delete price.outbound_call_prices[0].origination_prefixes;
    await expect(p.preflight(cfg.selfNumber, 180, NOW)).rejects.toThrow();
  });
  it("fails loud on missing dispatch telemetry", () => {
    expect(dispatchResponse.safeParse({ success: true, message: "ok" }).success).toBe(false);
    expect(conversationSchema.safeParse({ status: "done" }).success).toBe(false);
  });
  it.each(["voice_fallback_url", "sms_fallback_url"])("rejects an unsafe %s independently", async field => {
    const { p, responses } = await setup();
    (responses[`/2010-04-01/Accounts/${cfg.twilioAccountSid}/IncomingPhoneNumbers/${cfg.twilioNumberSid}.json`] as any)[field] = "https://unsafe.example.com/receive";
    await expect(p.preflight(cfg.selfNumber, 180, NOW)).rejects.toMatchObject({ code: "ROUTING_UNSAFE" });
  });
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
