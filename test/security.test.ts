import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticate, readLimited, verifyEleven, verifyTwilio } from "../src/auth";
import worker from "../src/index";
import { createExecutionContext } from "cloudflare:test";
import { cfg, NOW } from "./fixtures";
import type { Env } from "../src/config";

async function sign(value: string, hash: "SHA-1" | "SHA-256") {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
describe("owner authentication", () => {
  it("accepts the exact owner with a valid issuer/audience and rejects substitutes", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey); const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
    const token = async (email = cfg.ownerEmail, aud = cfg.accessAudience, sub = cfg.ownerSubject, expired = false) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(cfg.accessIssuer).setAudience(aud).setSubject(sub).setIssuedAt().setExpirationTime(expired ? "-1s" : "1m").sign(privateKey);
    const req = (jwt: string) => new Request(cfg.publicOrigin + "/mcp", { headers: { "Cf-Access-Jwt-Assertion": jwt } });
    expect(await authenticate(req(await token()), cfg, keys)).toBe(cfg.ownerSubject);
    for (const jwt of [await token("stranger@example.com"), await token(cfg.ownerEmail, "wrong"), await token(cfg.ownerEmail, cfg.accessAudience, "wrong"), await token(cfg.ownerEmail, cfg.accessAudience, cfg.ownerSubject, true)]) await expect(authenticate(req(jwt), cfg, keys)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(authenticate(new Request(cfg.publicOrigin + "/mcp"), cfg, keys)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("does not expose management or audio through webhook-like paths or alternate hosts", async () => {
    const env = { SERVICE_CONFIG: JSON.stringify(cfg), CALLS: { idFromName: () => "owner", get: () => ({}) } } as unknown as Env;
    for (const path of ["/mcp", "/calls/00000000-0000-4000-8000-000000000000/recording", "/webhooks/elevenlabs/../mcp", "/webhooks/elevenlabs/extra", "/webhooks/twilio/inbound/extra"]) {
      const res = await worker.fetch(new Request(cfg.publicOrigin + path), env, createExecutionContext()); expect(res.status).toBe(401);
    }
    expect((await worker.fetch(new Request("https://alternate.workers.dev/mcp"), env, createExecutionContext())).status).toBe(403);
  });
});
describe("signed provider callbacks", () => {
  it("checks the ElevenLabs raw body, age, and signature", async () => {
    const raw = '{"event":"test"}'; const time = NOW / 1000;
    const signature = [...await sign(`${time}.${raw}`, "SHA-256")].map(v => v.toString(16).padStart(2, "0")).join("");
    await verifyEleven(raw, `t=${time},v0=${signature}`, "test-secret", NOW);
    await expect(verifyEleven(raw + " ", `t=${time},v0=${signature}`, "test-secret", NOW)).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    await expect(verifyEleven(raw, `t=${time},v0=${signature}`, "test-secret", NOW + 301000)).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    await expect(verifyEleven(raw, null, "test-secret", NOW)).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });
  it("validates Twilio against the exact public URL and all form fields", async () => {
    const url = cfg.publicOrigin + "/webhooks/twilio/inbound";
    const body = new URLSearchParams({ AccountSid: cfg.twilioAccountSid, To: cfg.fromNumber });
    const value = url + "AccountSid" + cfg.twilioAccountSid + "To" + cfg.fromNumber;
    const signature = btoa(String.fromCharCode(...await sign(value, "SHA-1")));
    expect((await verifyTwilio(url, body.toString(), signature, "test-secret")).get("To")).toBe(cfg.fromNumber);
    await expect(verifyTwilio(url + "/", body.toString(), signature, "test-secret")).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
    await expect(verifyTwilio(url, body.toString() + "&Extra=untrusted", signature, "test-secret")).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });
  it("rejects inbound voice with no answering verb", async () => {
    const url = cfg.publicOrigin + "/webhooks/twilio/inbound";
    const body = new URLSearchParams({ AccountSid: cfg.twilioAccountSid, To: cfg.fromNumber });
    const signature = btoa(String.fromCharCode(...await sign(url + "AccountSid" + cfg.twilioAccountSid + "To" + cfg.fromNumber, "SHA-1")));
    const env = { SERVICE_CONFIG: JSON.stringify(cfg), TWILIO_AUTH_TOKEN: "test-secret", CALLS: { idFromName: () => "owner", get: () => ({}) } } as unknown as Env;
    const res = await worker.fetch(new Request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature }, body }), env, createExecutionContext());
    expect(res.status).toBe(200); expect(await res.text()).toBe('<Response><Reject reason="rejected"/></Response>');
  });
  it("bounds streamed request bodies even without Content-Length", async () => {
    await expect(readLimited(new Request("https://example.com", { method: "POST", body: "12345" }), 4)).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
    expect(await readLimited(new Request("https://example.com", { method: "POST", body: "1234" }), 4)).toBe("1234");
  });
});
