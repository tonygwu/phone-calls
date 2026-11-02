import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { canonical } from "../src/contracts";
import { configSchema } from "../src/config";
import { setupSchema, type Setup } from "./setup-config";

type Runner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; encoding?: "utf8"; stdio?: "inherit" }) => { status: number | null; stdout?: string; stderr?: string };
const runCommand: Runner = (command, args, options) => {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? undefined, stderr: result.stderr ?? undefined };
};
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => sha(canonical(value));
function parseJson(value: string, label: string) {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} is not valid JSON. Correct the private file without pasting its contents into chat.`); }
}
function load(file: string) { return parseJson(readFileSync(file, "utf8"), basename(file)); }
const resourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function privateDirectory(cwd: string) {
  const path = join(cwd, "private");
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error("private must be an ordinary directory in this checkout.");
  mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700);
  return path;
}
function saveRaw(cwd: string, name: string, value: string) {
  const file = join(privateDirectory(cwd), name), temporary = `${file}.tmp-${randomUUID()}`;
  writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
function save(cwd: string, name: string, value: unknown) { saveRaw(cwd, name, JSON.stringify(value, null, 2) + "\n"); }
function parsedSetup(cwd: string): Setup {
  try { return setupSchema.parse(load(join(cwd, "private/setup.json"))); }
  catch (error) {
    if (error instanceof z.ZodError) throw new Error(`Setup fields need attention: ${error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    throw new Error("Cannot read private/setup.json. Run npm run setup -- init first.");
  }
}
function placeholders(setup: Setup) {
  const invalid = Object.entries(setup).filter(([key, value]) => typeof value === "string" && (
    value.includes("REPLACE_") || value.includes("your-team.") || value === "https://calls.example.com" || value === "owner@example.com" || value === "Example Owner" ||
    (key === "twilioAccountSid" && /^AC0+$/.test(value)) || (key === "cloudflareAccountId" && /^0+$/.test(value))
  )).map(([key]) => key);
  if (invalid.length) throw new Error(`Replace the example values in private/setup.json: ${invalid.join(", ")}. Run npm run setup to configure them.`);
}
function credentials(env: NodeJS.ProcessEnv) {
  for (const name of ["ELEVENLABS_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) {
    if (!env[name]?.trim()) throw new Error(`Set ${name} in .dev.vars before continuing. Never put a credential on the command line.`);
  }
  if (!/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID!)) throw new Error("TWILIO_ACCOUNT_SID must be the account SID from Twilio Console.");
}

export function initialize(cwd = process.cwd()) {
  privateDirectory(cwd);
  const created: string[] = [], preserved: string[] = [];
  for (const [name, source] of [[".dev.vars", ".dev.vars.example"], ["private/setup.json", "examples/setup.json"]]) {
    const file = join(cwd, name);
    if (existsSync(file)) { preserved.push(name); continue; }
    writeFileSync(file, readFileSync(join(resourceRoot, source)), { mode: 0o600, flag: "wx" }); created.push(name);
  }
  return { created, preserved, next: "Fill the three provider credentials in .dev.vars, sign in to Cloudflare, then run npm run setup.", calls_placed: 0 };
}

export function checkSetup(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  const setup = parsedSetup(cwd); placeholders(setup); credentials(env);
  if (env.TWILIO_ACCOUNT_SID !== setup.twilioAccountSid) throw new Error("TWILIO_ACCOUNT_SID does not match private/setup.json.");
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== setup.cloudflareAccountId) throw new Error("CLOUDFLARE_ACCOUNT_ID does not match private/setup.json.");
  return { valid: true, external_checks: 0, calls_placed: 0, next: "npm run preflight, then npm run inspect:accounts" };
}

export function resolveOwner(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, run: Runner = runCommand, input?: Omit<Setup, "ownerSubject">) {
  const setup = input ?? load(join(cwd, "private/setup.json"));
  const identity = z.object({ ownerEmail: z.email(), cloudflareAccountId: z.string().regex(/^[a-f0-9]{32}$/i) }).parse(setup);
  const response = run(join(cwd, "node_modules/.bin/cf"), ["zero-trust", "access", "users", "list", "--email", identity.ownerEmail, "--per-page", "2"], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: identity.cloudflareAccountId }, encoding: "utf8",
  });
  saveRaw(cwd, "setup-owner-response.json", response.stdout ?? "");
  if (response.status !== 0) throw new Error("Cloudflare Access user lookup failed. Check cf authentication and Access read permissions. The private raw response was saved.");
  let users: { id: string; email: string }[];
  try { users = z.array(z.object({ id: z.uuid(), email: z.email() })).parse(JSON.parse(response.stdout!)); }
  catch { throw new Error("Cloudflare Access returned an unexpected user response. Inspect private/setup-owner-response.json."); }
  // Two results suffice to refuse ambiguity; no result is selected from a truncated list.
  if (users.length !== 1 || users[0].email !== identity.ownerEmail) throw new Error("Cloudflare Access must return exactly one user with the configured email. Sign in to your team's App Launcher first, then retry this read-only lookup.");
  const configured = setupSchema.parse({ ...setup, ownerSubject: users[0].id });
  save(cwd, "setup.json", configured);
  return { ownerSubject: users[0].id, ownerEmail: identity.ownerEmail, calls_placed: 0, external_changes: 0 };
}

export async function configure(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, ask?: (label: string) => Promise<string>, run: Runner = runCommand) {
  if (["service-config.json", "provision-journal.json"].some(file => existsSync(join(cwd, "private", file)))) throw new Error("This is an existing installation. Edit its private configuration through the maintenance procedure instead of rerunning the first-install wizard.");
  credentials(env);
  if (!ask) throw new Error("An interactive terminal is required. Use npm run setup -- init for editable templates.");
  const questioner = ask;
  async function question(label: string, schema: z.ZodType<string>, fallback?: string) {
    const value = (await questioner(`${label}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return schema.parse(value || fallback);
  }
  const publicOrigin = await question("Service URL, such as https://calls.your-domain.com", setupSchema.shape.publicOrigin);
  const accessIssuer = await question("Zero Trust team URL, such as https://your-team.cloudflareaccess.com", setupSchema.shape.accessIssuer);
  const cloudflareAccountId = await question("Cloudflare account ID", setupSchema.shape.cloudflareAccountId, env.CLOUDFLARE_ACCOUNT_ID);
  const ownerEmail = await question("Email you use to sign in to Access", setupSchema.shape.ownerEmail);
  const ownerName = await question("Name the caller should use for you", setupSchema.shape.ownerName);
  const selfNumber = await question("Your US phone number, +1XXXXXXXXXX", setupSchema.shape.selfNumber);
  const callbackNumber = await question("Your callback number", setupSchema.shape.callbackNumber, selfNumber);
  const selectedNumber = await question("Available Twilio number to PURCHASE, +1XXXXXXXXXX", setupSchema.shape.selectedNumber);
  const voiceId = await question("ElevenLabs voice ID", setupSchema.shape.voiceId, "JBFqnCBsd6RMkjVDRZzb");
  const redirects = (await ask("Exact remote OAuth callback URI, or Enter to add ChatGPT later: ")).trim();
  const oauthRedirectUris = setupSchema.shape.oauthRedirectUris.parse(redirects ? [redirects] : []);
  const setup = { publicOrigin, accessIssuer, cloudflareAccountId, ownerEmail, ownerName, selfNumber, callbackNumber, selectedNumber, voiceId, oauthRedirectUris, twilioAccountSid: env.TWILIO_ACCOUNT_SID! };
  placeholders(setupSchema.parse({ ...setup, ownerSubject: "pending-owner-lookup" }));
  resolveOwner(cwd, env, run, setup);
  return { configured: true, next: "npm run setup -- check", calls_placed: 0, external_changes: 0 };
}

function deploymentInputs(cwd: string) {
  const setup = parsedSetup(cwd); placeholders(setup);
  const config = configSchema.parse(load(join(cwd, "private/service-config.json")));
  const secrets = z.object({ SERVICE_CONFIG: z.string(), ELEVENLABS_API_KEY: z.string().min(1), ELEVENLABS_WEBHOOK_SECRET: z.string().min(1), TWILIO_AUTH_TOKEN: z.string().min(1) }).parse(load(join(cwd, "private/worker-secrets.json")));
  if (canonical(configSchema.parse(parseJson(secrets.SERVICE_CONFIG, "SERVICE_CONFIG"))) !== canonical(config)) throw new Error("The Worker secret configuration does not match private/service-config.json.");
  for (const [key, value] of Object.entries(setup)) {
    if (["cloudflareAccountId", "oauthRedirectUris"].includes(key)) continue;
    const field = key === "selectedNumber" ? "fromNumber" : key;
    if (value !== undefined && canonical(value) !== canonical(config[field as keyof typeof config])) throw new Error(`Installed configuration does not match setup field ${key}.`);
  }
  return { setup, config };
}
function deploymentReview(cwd: string) {
  const { setup, config } = deploymentInputs(cwd);
  const output = join(cwd, ".cloudflare/output/v0/workers/default");
  const bytes = readFileSync(join(output, "worker.config.json")), built = JSON.parse(bytes.toString());
  if (built.name !== "phone-calls-mcp" || canonical(built.domains) !== canonical([new URL(config.publicOrigin).hostname])) throw new Error("Build output must contain only this installation's hostname.");
  if (built.workersDev !== false || built.previewUrls !== false) throw new Error("Alternate workers.dev and preview URLs must be disabled.");
  return { verdict: "ship", buildSha256: sha(readFileSync(join(output, "bundle/index.js"))), secretsSha256: sha(readFileSync(join(cwd, "private/worker-secrets.json"))), workerConfigSha256: sha(bytes), cloudflareAccountId: setup.cloudflareAccountId };
}
export function buildForDeployment(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, run: Runner = runCommand) {
  const { setup, config } = deploymentInputs(cwd);
  const result = run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check"], {
    cwd, env: { ...env, CLOUDFLARE_ACCOUNT_ID: setup.cloudflareAccountId, PHONE_CALLS_HOSTNAME: new URL(config.publicOrigin).hostname }, stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Build/check failed. No deployment plan was prepared.");
  const review = deploymentReview(cwd), planSha256 = hash(review);
  save(cwd, "deploy-plan.json", { hash: planSha256, review, instructions: "Obtain a fresh ship review of the build, account, private configuration and Access readbacks before recording approval. This file is not approval." });
  return { prepared: "private/deploy-plan.json", planSha256, approved: false, deployed: false, calls_placed: 0 };
}

export function recordReview(kind: string, reviewedHash: string, cwd = process.cwd()) {
  if (!/^[a-f0-9]{64}$/.test(reviewedHash)) throw new Error("Supply the exact SHA-256 hash that received a fresh ship review.");
  if (kind === "provision") {
    const plan = z.object({ hash: z.string(), plan: z.unknown() }).parse(load(join(cwd, "private/provision-plan.json")));
    if (plan.hash !== reviewedHash || hash(plan.plan) !== reviewedHash) throw new Error("Provision plan hash changed or does not match the reviewed hash.");
    save(cwd, "provision-review.json", { verdict: "ship", planSha256: reviewedHash });
  } else if (kind === "deploy") {
    const plan = load(join(cwd, "private/deploy-plan.json")), current = deploymentReview(cwd);
    if (plan.hash !== reviewedHash || hash(plan.review) !== reviewedHash || hash(current) !== reviewedHash) throw new Error("Deployment inputs changed or the hash does not match the reviewed plan. Build and review again.");
    save(cwd, "deploy-review.json", current);
  } else throw new Error("Review kind must be provision or deploy.");
  return { recorded: `private/${kind}-review.json`, applied: false, deployed: false, calls_placed: 0 };
}

const help = `Usage: npm run setup -- [init|check|owner|build|review provision HASH|review deploy HASH]
  No arguments: configure a first installation interactively and read its Access owner identity.
  init: create private templates without overwriting existing files.
  check: validate local inputs without network requests.
  owner: resolve the owner with one read-only Cloudflare Access lookup.
  build: run npm run check with the installation hostname and prepare deployment hashes.
  review: record a fresh review of the supplied exact hash; never grants review automatically.
These commands never purchase resources, deploy, or place calls. Read README.md first.`;
async function main(args: string[]) {
  const [mode, ...rest] = args;
  if (mode === "--help" || mode === "help") { console.log(help); return; }
  if (mode === undefined && args.length === 0) {
    if (!process.stdin.isTTY) throw new Error("Use an interactive terminal for npm run setup, or use init and edit the private templates.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { console.log(await configure(process.cwd(), process.env, label => rl.question(label))); }
    finally { rl.close(); }
  } else if (mode === "review" && rest.length === 2) console.log(recordReview(rest[0], rest[1]));
  else if (rest.length) throw new Error(help);
  else if (mode === "init") console.log(initialize());
  else if (mode === "check") console.log(checkSetup());
  else if (mode === "owner") console.log(resolveOwner());
  else if (mode === "build") console.log(buildForDeployment());
  else throw new Error(help);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof z.ZodError ? "One or more setup answers are invalid. Use the formats in README.md and try again." : error.message); process.exitCode = 1; });
}
