import { z } from "zod";
import { usPhone, CallError } from "./contracts";
import type { CallLedger } from "./ledger";

export const configSchema = z.strictObject({
  publicOrigin: z.url().refine(s => new URL(s).protocol === "https:" && new URL(s).origin === s),
  accessIssuer: z.url().refine(s => /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(s)),
  accessAudience: z.string().min(32),
  ownerEmail: z.email(), ownerSubject: z.string().min(1), ownerName: z.string().min(1).max(100),
  selfNumber: usPhone, callbackNumber: usPhone,
  twilioAccountSid: z.string().regex(/^AC[a-fA-F0-9]{32}$/),
  twilioNumberSid: z.string().regex(/^PN[a-fA-F0-9]{32}$/),
  fromNumber: usPhone,
  elevenAgentId: z.string().min(1), elevenPhoneId: z.string().min(1), voiceId: z.string().min(1),
});
export type Config = z.infer<typeof configSchema>;
export interface Env {
  CALLS: DurableObjectNamespace<CallLedger>;
  SERVICE_CONFIG?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_WEBHOOK_SECRET?: string;
  TWILIO_AUTH_TOKEN?: string;
}
export function config(env: Env): Config {
  if (!env.SERVICE_CONFIG) throw new CallError("SETUP_REQUIRED", "SERVICE_CONFIG has not been installed.", false, 503);
  try { return configSchema.parse(JSON.parse(env.SERVICE_CONFIG)); }
  catch { throw new CallError("INVALID_CONFIG", "SERVICE_CONFIG is invalid. Run the local preflight to see field-level diagnostics.", false, 503); }
}
export function secret(env: Env, name: "ELEVENLABS_API_KEY" | "ELEVENLABS_WEBHOOK_SECRET" | "TWILIO_AUTH_TOKEN") {
  const value = env[name];
  if (!value) throw new CallError("SETUP_REQUIRED", `${name} has not been installed.`, false, 503);
  return value;
}
