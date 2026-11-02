import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const config = JSON.parse(readFileSync("private/service-config.json", "utf8"));
const setup = JSON.parse(readFileSync("private/setup.json", "utf8"));
const review = JSON.parse(readFileSync("private/deploy-review.json", "utf8"));
const built = readFileSync(".cloudflare/output/v0/workers/default/bundle/index.js");
const buildHash = createHash("sha256").update(built).digest("hex");
const secretsBytes = readFileSync("private/worker-secrets.json");
const secretsHash = createHash("sha256").update(secretsBytes).digest("hex");
const outputBytes = readFileSync(".cloudflare/output/v0/workers/default/worker.config.json");
const configHash = createHash("sha256").update(outputBytes).digest("hex");
if (review.verdict !== "ship" || review.buildSha256 !== buildHash || review.secretsSha256 !== secretsHash || review.workerConfigSha256 !== configHash || review.cloudflareAccountId !== setup.cloudflareAccountId) throw new Error("Deployment requires a fresh ship review of this exact build, account and private configuration.");
let workerSecrets, installedConfig;
try {
  workerSecrets = JSON.parse(secretsBytes.toString());
  if (!workerSecrets || typeof workerSecrets !== "object" || Array.isArray(workerSecrets) || typeof workerSecrets.SERVICE_CONFIG !== "string") throw new Error();
  installedConfig = JSON.parse(workerSecrets.SERVICE_CONFIG);
  if (!installedConfig || typeof installedConfig !== "object" || Array.isArray(installedConfig)) throw new Error();
} catch {
  throw new Error("Worker secrets must contain valid JSON and a valid SERVICE_CONFIG.");
}
if (installedConfig.conferenceSip) {
  for (const name of ["ELEVENLABS_SIP_PASSWORD", "ELEVENLABS_INITIATION_SECRET"]) {
    if (typeof workerSecrets[name] !== "string" || !workerSecrets[name]) throw new Error(`${name} has not been installed. Run the reviewed SIP setup before deploying.`);
  }
}
if (!config.publicOrigin?.startsWith("https://")) throw new Error("Missing private hostname");
const output = JSON.parse(outputBytes.toString());
// The deployment review must check the emitted custom domain, disabled workers.dev
// and disabled preview URLs, as well as the three Access application readbacks.
if (output.name !== "phone-calls-mcp" || output.workersDev !== false || output.previewUrls !== false || JSON.stringify(output.domains) !== JSON.stringify([new URL(config.publicOrigin).hostname])) throw new Error("Build output must use only the reviewed hostname with workers.dev and previews disabled.");
if (!/^[a-f0-9]{32}$/i.test(setup.cloudflareAccountId)) throw new Error("Missing selected Cloudflare account ID.");
const result = spawnSync("node_modules/.bin/cf", ["deploy", "--prebuilt", "--secrets-file", "private/worker-secrets.json"], { stdio: "inherit", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: setup.cloudflareAccountId, PHONE_CALLS_HOSTNAME: new URL(config.publicOrigin).hostname } });
process.exit(result.status ?? 1);
