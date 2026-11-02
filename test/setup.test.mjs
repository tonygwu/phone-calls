import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initialize, configure, checkSetup, resolveOwner, buildForDeployment, recordReview } from "../scripts/setup.ts";
import { canonical, digest } from "../src/contracts.ts";

const setup = {
  publicOrigin: "https://calls.example.net", accessIssuer: "https://example.cloudflareaccess.com",
  ownerEmail: "owner@example.net", ownerSubject: "11111111-2222-4333-8444-555555555555", ownerName: "Test Owner",
  selfNumber: "+12025550199", callbackNumber: "+12025550199", twilioAccountSid: "AC" + "1".repeat(32),
  voiceId: "public-stock-voice", selectedNumber: "+14155550100", cloudflareAccountId: "a".repeat(32), oauthRedirectUris: [],
};
const env = { TWILIO_ACCOUNT_SID: setup.twilioAccountSid, TWILIO_AUTH_TOKEN: "synthetic-twilio-token", ELEVENLABS_API_KEY: "synthetic-eleven-key" };
const config = { ...setup, fromNumber: setup.selectedNumber, twilioNumberSid: "PN" + "2".repeat(32),
  accessAudience: "b".repeat(64), elevenAgentId: "agent_test", elevenPhoneId: "phone_test" };
for (const key of ["selectedNumber", "cloudflareAccountId", "oauthRedirectUris"]) delete config[key];
const json = value => JSON.stringify(value, null, 2) + "\n";
const read = file => JSON.parse(readFileSync(file, "utf8"));
const root = resolve(import.meta.dirname, "..");
async function scenario(fn) {
  const cwd = mkdtempSync(join(tmpdir(), "phone-setup-"));
  try { mkdirSync(join(cwd, "private")); await fn(cwd); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}
function inputs(cwd) { writeFileSync(join(cwd, "private/setup.json"), json(setup)); }
function deployedFiles(cwd) {
  inputs(cwd);
  writeFileSync(join(cwd, "private/service-config.json"), json(config));
  writeFileSync(join(cwd, "private/worker-secrets.json"), json({ SERVICE_CONFIG: JSON.stringify(config), ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY, TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN, ELEVENLABS_WEBHOOK_SECRET: "synthetic-webhook-secret" }));
  const output = join(cwd, ".cloudflare/output/v0/workers/default");
  mkdirSync(join(output, "bundle"), { recursive: true });
  writeFileSync(join(output, "bundle/index.js"), "synthetic reviewed worker");
  writeFileSync(join(output, "worker.config.json"), json({ name: "phone-calls-mcp", domains: ["calls.example.net"], workersDev: false, previewUrls: false }));
}

test("init creates private templates once and preserves existing credential bytes", () => scenario(async cwd => {
  const credentials = "# existing\nTWILIO_AUTH_TOKEN=synthetic-kept\n";
  writeFileSync(join(cwd, ".dev.vars"), credentials, { mode: 0o600 });
  const result = initialize(cwd);
  assert.deepEqual(result.created, ["private/setup.json"]);
  assert.equal(readFileSync(join(cwd, ".dev.vars"), "utf8"), credentials);
  assert.equal(statSync(join(cwd, "private/setup.json")).mode & 0o777, 0o600);
  assert.deepEqual(initialize(cwd).created, []);
}));

test("local validation reports placeholders and missing credentials without exposing values", () => scenario(async cwd => {
  initialize(cwd);
  assert.throws(() => checkSetup(cwd, env), /publicOrigin|ownerSubject|cloudflareAccountId/);
  inputs(cwd);
  assert.throws(() => checkSetup(cwd, { ...env, ELEVENLABS_API_KEY: "" }), /ELEVENLABS_API_KEY/);
  assert.throws(() => checkSetup(cwd, { ...env, TWILIO_ACCOUNT_SID: "AC" + "2".repeat(32) }), /does not match/);
  assert.equal(checkSetup(cwd, env).valid, true);
}));

test("owner lookup binds the selected account and exact email, and saves the full raw response", () => scenario(async cwd => {
  inputs(cwd);
  let observed;
  const raw = json([{ id: setup.ownerSubject, email: setup.ownerEmail, name: "Test Owner", extra: { preserved: true } }]);
  const run = (command, args, options) => { observed = { command, args, options }; return { status: 0, stdout: raw, stderr: "" }; };
  const result = resolveOwner(cwd, env, run);
  assert.equal(result.ownerSubject, setup.ownerSubject);
  assert.equal(observed.options.env.CLOUDFLARE_ACCOUNT_ID, setup.cloudflareAccountId);
  assert.deepEqual(observed.args, ["zero-trust", "access", "users", "list", "--email", setup.ownerEmail, "--per-page", "2"]);
  assert.equal(readFileSync(join(cwd, "private/setup-owner-response.json"), "utf8"), raw);
  assert.equal(statSync(join(cwd, "private/setup-owner-response.json")).mode & 0o777, 0o600);
}));

for (const fault of ["missing", "duplicate", "wrong-email", "malformed", "cli-error"]) {
  test(`owner lookup fails closed on ${fault} and preserves configuration`, () => scenario(async cwd => {
    inputs(cwd); const before = readFileSync(join(cwd, "private/setup.json"), "utf8");
    const owner = { id: setup.ownerSubject, email: setup.ownerEmail };
    const stdout = fault === "missing" ? "[]" : fault === "duplicate" ? json([owner, owner]) : fault === "wrong-email" ? json([{ ...owner, email: "other@example.net" }]) : fault === "malformed" ? '{"unexpected":true}' : json([owner]);
    assert.throws(() => resolveOwner(cwd, env, () => ({ status: fault === "cli-error" ? 1 : 0, stdout, stderr: "sensitive diagnostic must stay private" })), /Access|Cloudflare/);
    assert.equal(readFileSync(join(cwd, "private/setup.json"), "utf8"), before);
  }));
}

test("configuration wizard validates inputs, reads owner identity, and needs no guessed callback URI", () => scenario(async cwd => {
  initialize(cwd);
  const answers = [setup.publicOrigin, setup.accessIssuer, setup.cloudflareAccountId, setup.ownerEmail, setup.ownerName, setup.selfNumber, "", setup.selectedNumber, "", ""];
  const result = await configure(cwd, env, async () => { assert.ok(answers.length); return answers.shift(); }, () => ({ status: 0, stdout: json([{ id: setup.ownerSubject, email: setup.ownerEmail }]), stderr: "" }));
  assert.equal(answers.length, 0);
  assert.equal(result.configured, true);
  const saved = read(join(cwd, "private/setup.json"));
  assert.equal(saved.callbackNumber, setup.selfNumber);
  assert.deepEqual(saved.oauthRedirectUris, []);
  assert.equal(checkSetup(cwd, env).valid, true);
  writeFileSync(join(cwd, "private/service-config.json"), json(config));
  await assert.rejects(configure(cwd, env, async () => assert.fail("must not prompt")), /existing installation/);
}));

test("owner command works through the CLI in an isolated first installation", () => scenario(async cwd => {
  inputs(cwd); mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(cwd, "node_modules/.bin/cf"), `#!${process.execPath}\nif(process.env.CLOUDFLARE_ACCOUNT_ID!==${JSON.stringify(setup.cloudflareAccountId)})process.exit(3);\nconsole.log(JSON.stringify([{id:${JSON.stringify(setup.ownerSubject)},email:${JSON.stringify(setup.ownerEmail)}}]));`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), join(root, "scripts/setup.ts"), "owner"], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(join(cwd, "private/setup.json")).ownerSubject, setup.ownerSubject);
  assert.match(result.stdout, /external_changes: 0/);
  assert.ok(!result.stdout.includes(env.TWILIO_AUTH_TOKEN));
  assert.ok(!result.stdout.includes(env.ELEVENLABS_API_KEY));
}));

test("the real provisioning prepare command accepts an initially empty remote callback list", () => scenario(async cwd => {
  inputs(cwd);
  const result = spawnSync(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), join(root, "scripts/provision.ts"), "prepare"], { cwd, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const plan = read(join(cwd, "private/provision-plan.json"));
  assert.deepEqual(plan.plan.access.oauth_configuration.dynamic_client_registration.allowed_uris, []);
  assert.equal(plan.hash, await digest(canonical(plan.plan)));
  assert.throws(() => readFileSync(join(cwd, "private/provision-journal.json")), { code: "ENOENT" });
}));

test("provision review requires the exact hash and never runs apply", () => scenario(async cwd => {
  const plan = { synthetic: "reviewable plan" }; const hash = await digest(canonical(plan));
  writeFileSync(join(cwd, "private/provision-plan.json"), json({ hash, plan }));
  assert.throws(() => recordReview("provision", "0".repeat(64), cwd), /hash/);
  recordReview("provision", hash, cwd);
  assert.deepEqual(read(join(cwd, "private/provision-review.json")), { verdict: "ship", planSha256: hash });
  writeFileSync(join(cwd, "private/provision-plan.json"), json({ hash, plan: { changed: true } }));
  assert.throws(() => recordReview("provision", hash, cwd), /hash/);
}));

test("build selects the installation hostname/account and prepares hashes without approving or deploying", () => scenario(async cwd => {
  deployedFiles(cwd); let command;
  const result = buildForDeployment(cwd, env, (name, args, options) => { command = { name, args, options }; return { status: 0 }; });
  assert.deepEqual(command.args, ["run", "check"]);
  assert.equal(command.options.env.PHONE_CALLS_HOSTNAME, "calls.example.net");
  assert.equal(command.options.env.CLOUDFLARE_ACCOUNT_ID, setup.cloudflareAccountId);
  assert.equal(result.deployed, false);
  assert.equal(result.approved, false);
  assert.throws(() => readFileSync(join(cwd, "private/deploy-review.json")), { code: "ENOENT" });
  const plan = read(join(cwd, "private/deploy-plan.json"));
  assert.equal(plan.review.cloudflareAccountId, setup.cloudflareAccountId);
  assert.equal(result.planSha256, plan.hash);
  recordReview("deploy", plan.hash, cwd);
  assert.deepEqual(read(join(cwd, "private/deploy-review.json")), plan.review);
}));

test("recorded deployment review is accepted by the real deployment gate with an isolated CLI", () => scenario(async cwd => {
  deployedFiles(cwd);
  const plan = buildForDeployment(cwd, env, () => ({ status: 0 }));
  recordReview("deploy", plan.planSha256, cwd);
  mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(cwd, "node_modules/.bin/cf"), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),account:process.env.CLOUDFLARE_ACCOUNT_ID,hostname:process.env.PHONE_CALLS_HOSTNAME}));`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [join(root, "scripts/deploy.mjs")], { cwd, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.account, setup.cloudflareAccountId);
  assert.equal(output.hostname, "calls.example.net");
  assert.deepEqual(output.args, ["deploy", "--prebuilt", "--secrets-file", "private/worker-secrets.json"]);
}));

test("malformed private secret JSON fails without echoing the secret", () => scenario(async cwd => {
  deployedFiles(cwd);
  const sentinel = "synthetic-sensitive-value-must-not-print";
  writeFileSync(join(cwd, "private/worker-secrets.json"), sentinel);
  const result = spawnSync(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), join(root, "scripts/setup.ts"), "build"], { cwd, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worker-secrets.json is not valid JSON/);
  assert.ok(!result.stderr.includes(sentinel));
  assert.ok(!result.stdout.includes(sentinel));
}));

for (const fault of ["build-failed", "wrong-domain", "alternate-urls", "secret-config-mismatch", "changed-build"]) {
  test(`deployment preparation/review rejects ${fault}`, () => scenario(async cwd => {
    deployedFiles(cwd);
    const output = join(cwd, ".cloudflare/output/v0/workers/default/worker.config.json");
    if (fault === "wrong-domain" || fault === "alternate-urls") {
      const value = read(output); if (fault === "wrong-domain") value.domains = ["other.example.net"]; else value.workersDev = true;
      writeFileSync(output, json(value));
    }
    if (fault === "secret-config-mismatch") {
      const file = join(cwd, "private/worker-secrets.json"), value = read(file);
      value.SERVICE_CONFIG = JSON.stringify({ ...config, ownerSubject: "other-owner" }); writeFileSync(file, json(value));
    }
    const run = () => ({ status: fault === "build-failed" ? 1 : 0 });
    if (fault === "changed-build") {
      const plan = buildForDeployment(cwd, env, run);
      writeFileSync(join(cwd, ".cloudflare/output/v0/workers/default/bundle/index.js"), "changed after review");
      assert.throws(() => recordReview("deploy", plan.planSha256, cwd), /changed|hash/);
    } else assert.throws(() => buildForDeployment(cwd, env, run), /build|Build|hostname|URLs|configuration/);
  }));
}
