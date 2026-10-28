import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { configSchema } from "../src/config.ts";

const names = ["ELEVENLABS_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
const credentials = Object.fromEntries(names.map(name => [name, Boolean(process.env[name])]));
const cf = spawnSync("node_modules/.bin/cf", ["auth", "whoami"], { encoding: "utf8" });
let cloudflareAuthenticated = false;
try {
  const identity = JSON.parse(cf.stdout);
  cloudflareAuthenticated = cf.status === 0 && identity.authenticated === true && identity.tokenValid === true;
} catch { /* Missing or malformed authentication evidence stays explicitly false. */ }
const configured = existsSync("private/service-config.json");
let configValid = null;
let issues = [];
if (configured) {
  try {
    const result = configSchema.safeParse(JSON.parse(readFileSync("private/service-config.json", "utf8")));
    configValid = result.success;
    if (!result.success) issues = result.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message }));
  } catch { configValid = false; issues = [{ path: "SERVICE_CONFIG", message: "Configuration is not readable JSON." }]; }
}
// A missing config is expected before provisioning. An existing invalid config
// is an error. This local check does not claim live phone-call readiness.
console.log(JSON.stringify({ credentials, cloudflare_authenticated: cloudflareAuthenticated, service_config_present: configured, service_config_valid: configValid, config_issues: issues, calls_placed_by_this_check: 0 }, null, 2));
if (Object.values(credentials).some(value => !value) || !cloudflareAuthenticated || configValid === false) process.exitCode = 2;
