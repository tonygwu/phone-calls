import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { CallError } from "./contracts";
import type { Config } from "./config";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(request: Request, c: Config, suppliedKeys?: JWTVerifyGetKey) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new CallError("UNAUTHENTICATED", "Sign in through the Cloudflare Access application.", false, 401);
  let keys = suppliedKeys ?? keySets.get(c.accessIssuer);
  if (!keys) { const remote = createRemoteJWKSet(new URL(`${c.accessIssuer}/cdn-cgi/access/certs`)); keySets.set(c.accessIssuer, remote); keys = remote; }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: c.accessIssuer, audience: c.accessAudience, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "email"] });
    if (payload.sub !== c.ownerSubject || payload.email !== c.ownerEmail) throw new Error("Owner mismatch");
    return payload.sub;
  } catch { throw new CallError("UNAUTHENTICATED", "The Access token is invalid, expired, or belongs to another identity.", false, 401); }
}
const encoder = new TextEncoder();
async function hmac(secret: string, data: string, hash: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}
export function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let n = 0; n < a.length; n++) diff |= a.charCodeAt(n) ^ b.charCodeAt(n);
  return diff === 0;
}
export async function verifyEleven(body: string, header: string | null, secret: string, now = Date.now()) {
  if (!header) throw new CallError("BAD_SIGNATURE", "Missing provider signature.", false, 401);
  const parts = header.split(",").map(p => p.trim());
  const times = parts.filter(p => p.startsWith("t="));
  if (times.length !== 1 || !/^t=\d+$/.test(times[0])) throw new CallError("BAD_SIGNATURE", "Malformed provider timestamp.", false, 401);
  const timestamp = times[0].slice(2);
  // Five-minute tolerance follows the provider's SDK verification window.
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) throw new CallError("BAD_SIGNATURE", "Provider signature timestamp is outside the accepted window.", false, 401);
  const expected = [...await hmac(secret, `${timestamp}.${body}`, "SHA-256")].map(x => x.toString(16).padStart(2, "0")).join("");
  if (!parts.some(p => p.startsWith("v0=") && equal(p.slice(3), expected))) throw new CallError("BAD_SIGNATURE", "Invalid provider signature.", false, 401);
}
export async function verifyTwilio(url: string, body: string, signature: string | null, secret: string) {
  const params = new URLSearchParams(body);
  const keys = [...new Set(params.keys())].sort();
  const data = url + keys.map(key => [...new Set(params.getAll(key))].sort().map(value => key + value).join("")).join("");
  const expected = btoa(String.fromCharCode(...await hmac(secret, data, "SHA-1")));
  if (!signature || !equal(signature, expected)) throw new CallError("BAD_SIGNATURE", "Invalid Twilio signature.", false, 401);
  return params;
}
export async function readLimited(request: Pick<Request, "body">, limit: number) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new CallError("BODY_TOO_LARGE", `Request exceeds the ${limit}-byte limit.`, false, 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}
