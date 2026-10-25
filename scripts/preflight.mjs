import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const names = ["ELEVENLABS_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
const credentials = Object.fromEntries(names.map(name => [name, Boolean(process.env[name])]));
const cf = spawnSync("node_modules/.bin/cf", ["auth", "whoami"], { encoding: "utf8" });
let cloudflare;
try { cloudflare = JSON.parse(cf.stdout); }
catch { cloudflare = { authenticated: false, error: "cf auth whoami did not return valid JSON" }; }
const configured = existsSync("private/service-config.json");
console.log(JSON.stringify({ credentials, cloudflare_authenticated: cloudflare.authenticated === true || Boolean(process.env.CLOUDFLARE_API_TOKEN), service_config_present: configured, calls_placed_by_this_check: 0 }, null, 2));
if (configured) JSON.parse(readFileSync("private/service-config.json", "utf8"));
if (Object.values(credentials).some(value => !value)) process.exitCode = 2;
