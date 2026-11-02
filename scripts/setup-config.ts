import { z } from "zod";
import { configSchema } from "../src/config";
import { usPhone } from "../src/contracts";

const { twilioNumberSid: _number, fromNumber: _from, elevenAgentId: _agent, elevenPhoneId: _phone, accessAudience: _aud, ...fields } = configSchema.shape;
export const setupSchema = z.strictObject({
  ...fields,
  publicOrigin: z.url().refine(value => URL.canParse(value) && new URL(value).protocol === "https:" && new URL(value).origin === value, "Use an HTTPS origin without a path or trailing slash."),
  selectedNumber: usPhone,
  cloudflareAccountId: z.string().regex(/^[a-f0-9]{32}$/i),
  // Terminal clients use the separate localhost/loopback registration settings.
  // Remote clients are added only after the client displays its exact URI.
  oauthRedirectUris: z.array(z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && !value.includes("*");
  }, "Use an exact HTTPS callback URI without credentials, a fragment, or wildcards.")),
});
export type Setup = z.infer<typeof setupSchema>;
