import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentDefinition } from "../src/agent.ts";
import { cfg } from "./data.ts";
import { runAgentUpdate, agentFingerprint, configurationDiff, desiredPatch, assertPreserved } from "../scripts/agent-update.ts";
import * as updater from "../scripts/agent-update.ts";
import { canonical, digest } from "../src/contracts.ts";

const rawAgent = () => ({
  agent_id: cfg.elevenAgentId, ...agentDefinition(cfg.voiceId),
  version_id: "version_before", branch_id: "main_test", main_branch_id: "main_test",
  workflow: { nodes: { start: { type: "start" } }, edges: {} },
});
function merge(base, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) merge(base[key] ??= {}, value);
    else base[key] = structuredClone(value);
  }
  return base;
}
function harness() {
  const root = mkdtempSync(join(tmpdir(), "agent-update-test-"));
  mkdirSync(join(root, "private"));
  writeFileSync(join(root, "private/service-config.json"), JSON.stringify(cfg));
  const agent = rawAgent(); agent.conversation_config.agent.prompt.prompt = "Old conversation prompt";
  agent.platform_settings.workspace_overrides = { webhooks: { post_call_webhook_id: "synthetic-webhook", events: ["transcript"] } };
  const state = { agent, calls: [], logs: [], account: { user_id: "user_test", workspace_id: "workspace_test" }, patchFailure: false, loseWebhook: false };
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["xi-api-key"], "synthetic-key");
    const path = new URL(url).pathname;
    state.calls.push({ path, method: init.method, body: init.body });
    if (path === "/v1/user") { assert.equal(init.method, "GET"); return Response.json(state.account); }
    assert.equal(path, `/v1/convai/agents/${cfg.elevenAgentId}`);
    if (init.method === "GET") return Response.json(state.agent);
    assert.equal(init.method, "PATCH");
    merge(state.agent, JSON.parse(init.body)); state.agent.version_id = "version_after";
    if (state.loseWebhook) delete state.agent.platform_settings.workspace_overrides;
    if (state.patchFailure) throw new Error("synthetic response loss after commit");
    return Response.json(state.agent);
  };
  const options = { root, fetcher, apiKey: "synthetic-key", log: value => state.logs.push(value) };
  const read = name => JSON.parse(readFileSync(join(root, "private/agent-update", name), "utf8"));
  const review = () => writeFileSync(join(root, "private/agent-review.json"), JSON.stringify({ verdict: "ship", planSha256: read("plan.json").hash }));
  return { root, state, options, read, review, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("agent update diffs prompt precisely and preserves provider defaults", async () => {
  const agent = rawAgent();
  agent.platform_settings.auth.allowlist = [];
  const desired = agentDefinition(cfg.voiceId);
  assert.deepEqual(configurationDiff(agent, desired), []);
  assert.deepEqual(desiredPatch(agent, desired), {});
  agent.conversation_config.agent.prompt.prompt = "old";
  assert.deepEqual(configurationDiff(agent, desired), ["agent.conversation_config.agent.prompt.prompt"]);
  assert.deepEqual(desiredPatch(agent, desired), { conversation_config: { agent: { prompt: { prompt: desired.conversation_config.agent.prompt.prompt } } } });
});

test("agent fingerprint normalizes only the known null analysis field", async () => {
  const a = rawAgent(); const b = structuredClone(a);
  b.platform_settings.data_collection.outcome.non_sensitive_value = null;
  assert.equal(await agentFingerprint(a), await agentFingerprint(b));
  b.platform_settings.data_collection.outcome.non_sensitive_value = "unexpected";
  assert.notEqual(await agentFingerprint(a), await agentFingerprint(b));
  delete b.workflow;
  await assert.rejects(agentFingerprint(b), /missing required field/);
});

test("reviewed update PATCHes only changed prompt and reads back exact identity", async () => {
  const h = harness(); try {
    await runAgentUpdate("plan", h.options); h.review();
    await runAgentUpdate("apply", h.options);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
    const patch = JSON.parse(h.state.calls.find(c => c.method === "PATCH").body);
    assert.deepEqual(Object.keys(patch), ["conversation_config"]);
    assert.equal(h.read("journal.json").state, "done");
    assert.equal(h.state.agent.platform_settings.workspace_overrides.webhooks.post_call_webhook_id, "synthetic-webhook");
    assert.equal(h.state.agent.conversation_config.agent.prompt.prompt, agentDefinition(cfg.voiceId).conversation_config.agent.prompt.prompt);
    await runAgentUpdate("readback", h.options);
    await assert.rejects(runAgentUpdate("apply", h.options), /already applied/);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});

test("full agent updates preserve the installed owner connection tool", async () => {
  const h = harness(); try {
    const installed = ["synthetic_owner_connection_tool", "synthetic_existing_tool"];
    h.state.agent.conversation_config.agent.prompt.tool_ids = installed;
    await runAgentUpdate("plan", h.options);
    assert.ok(!h.read("plan.json").plan.changedPaths.includes("agent.conversation_config.agent.prompt.tool_ids"));
    h.review();
    await runAgentUpdate("apply", h.options);
    assert.deepEqual(h.state.agent.conversation_config.agent.prompt.tool_ids, installed);
    await runAgentUpdate("readback", h.options);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});

test("an update that drops the owner connection tool cannot pass or reconcile", async () => {
  const h = harness(); try {
    h.state.agent.conversation_config.agent.prompt.tool_ids = ["synthetic_owner_connection_tool"];
    const fetcher = h.options.fetcher;
    h.options.fetcher = async (url, init) => {
      const response = await fetcher(url, init);
      if (init.method === "PATCH") h.state.agent.conversation_config.agent.prompt.tool_ids = [];
      return response;
    };
    await runAgentUpdate("plan", h.options); h.review();
    await assert.rejects(runAgentUpdate("apply", h.options), /Unmanaged agent settings changed/);
    await assert.rejects(runAgentUpdate("readback", h.options), /Unmanaged agent settings changed/);
    assert.equal(h.read("journal.json").state, "intent");
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});

for (const fault of ["no-review", "review-hash", "agent-drift", "account-drift", "selected-config-drift"]) {
  test(`agent update refuses ${fault} before PATCH`, async () => {
    const h = harness(); try {
      await runAgentUpdate("plan", h.options);
      if (fault !== "no-review") h.review();
      if (fault === "review-hash") writeFileSync(join(h.root, "private/agent-review.json"), JSON.stringify({ verdict: "ship", planSha256: "0".repeat(64) }));
      if (fault === "agent-drift") h.state.agent.conversation_config.agent.prompt.temperature = 1;
      if (fault === "account-drift") h.state.account.workspace_id = "other_workspace";
      if (fault === "selected-config-drift") writeFileSync(join(h.root, "private/service-config.json"), JSON.stringify({ ...cfg, voiceId: "other_voice" }));
      await assert.rejects(runAgentUpdate("apply", h.options));
      assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 0);
    } finally { h.close(); }
  });
}

test("uncertain PATCH cannot repeat, and read-only readback reconciles it", async () => {
  const h = harness(); try {
    await runAgentUpdate("plan", h.options); h.review(); h.state.patchFailure = true;
    await assert.rejects(runAgentUpdate("apply", h.options), /private raw evidence/);
    assert.equal(h.read("journal.json").state, "intent");
    await assert.rejects(runAgentUpdate("apply", h.options), /uncertain/);
    await assert.rejects(runAgentUpdate("plan", h.options), /uncertain/);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
    await runAgentUpdate("readback", h.options);
    assert.equal(h.read("journal.json").state, "done");
    assert.equal(h.read("journal.json").reconciled, true);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});

test("lost webhook is a failed readback and cannot be reconciled as success", async () => {
  const h = harness(); try {
    await runAgentUpdate("plan", h.options); h.review(); h.state.loseWebhook = true;
    await assert.rejects(runAgentUpdate("apply", h.options), /Unmanaged agent settings changed/);
    assert.equal(h.read("journal.json").state, "intent");
    await assert.rejects(runAgentUpdate("readback", h.options), /Unmanaged agent settings changed/);
    assert.equal(h.read("journal.json").state, "intent");
  } finally { h.close(); }
});

test("wrong agent identity fails plan with zero PATCH calls", async () => {
  const h = harness(); try {
    h.state.agent.agent_id = "wrong_agent";
    await assert.rejects(runAgentUpdate("plan", h.options), /Agent identity mismatch/);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 0);
  } finally { h.close(); }
});

test("preservation rejects workflow changes outside the desired definition", async () => {
  const before = rawAgent(); const after = structuredClone(before);
  after.workflow.nodes.injected = { type: "phone_number", destination: "+12025550100" };
  await assert.rejects(assertPreserved(before, after, agentDefinition(cfg.voiceId)), /Unmanaged agent settings changed/);
});

const permissionDesired = { platform_settings: { overrides: { conversation_config_override: { agent: { prompt: { prompt: true } } } } } };
const permissionPath = "agent.platform_settings.overrides.conversation_config_override.agent.prompt.prompt";
function disablePromptPermission(h) {
  const prompt = h.state.agent.platform_settings.overrides.conversation_config_override.agent.prompt;
  prompt.prompt = false;
  prompt.llm = false;
  prompt.tool_ids = false;
}

test("CLI accepts permission-only solely as an explicit plan flag", () => {
  const { parseAgentUpdateArguments } = updater;
  assert.deepEqual(parseAgentUpdateArguments(["plan"]), { mode: "plan" });
  assert.deepEqual(parseAgentUpdateArguments(["plan", "--permission-only"]), { mode: "plan", scope: "permission-only" });
  assert.deepEqual(parseAgentUpdateArguments(["apply"]), { mode: "apply" });
  assert.deepEqual(parseAgentUpdateArguments(["readback"]), { mode: "readback" });
  for (const args of [["apply", "--permission-only"], ["readback", "--permission-only"], ["plan", "--permission-only", "--permission-only"], ["plan", "--unknown"], []]) {
    assert.throws(() => parseAgentUpdateArguments(args), /Usage/);
  }
});

test("default plan explicitly binds the full update scope", async () => {
  const h = harness(); try {
    await runAgentUpdate("plan", h.options);
    assert.equal(h.read("plan.json").plan.scope, "full");
  } finally { h.close(); }
});

test("permission-only plan applies one permission and readback does not claim the prompt changed", async () => {
  const h = harness(); try {
    disablePromptPermission(h);
    const before = structuredClone(h.state.agent);
    await runAgentUpdate("plan", { ...h.options, scope: "permission-only" });
    const prepared = h.read("plan.json");
    assert.equal(prepared.plan.scope, "permission-only");
    assert.deepEqual(prepared.plan.patch, permissionDesired);
    assert.deepEqual(prepared.plan.changedPaths, [permissionPath]);
    assert.equal(prepared.plan.desiredSha256, await digest(canonical(permissionDesired)));
    h.review();
    await runAgentUpdate("apply", h.options);
    assert.deepEqual(JSON.parse(h.state.calls.find(c => c.method === "PATCH").body), permissionDesired);
    assert.equal(h.state.agent.conversation_config.agent.prompt.prompt, before.conversation_config.agent.prompt.prompt);
    assert.equal(h.state.agent.platform_settings.overrides.conversation_config_override.agent.prompt.llm, false);
    assert.equal(h.state.agent.platform_settings.overrides.conversation_config_override.agent.prompt.tool_ids, false);
    assert.deepEqual(h.state.agent.platform_settings.workspace_overrides, before.platform_settings.workspace_overrides);
    assert.equal(h.read("journal.json").scope, "permission-only");
    await runAgentUpdate("readback", h.options);
    const readback = h.state.logs.at(-1);
    assert.equal(readback.scope, "permission-only");
    assert.equal(readback.prompt_override_permission_enabled, true);
    assert.equal(readback.managed_config_matches_plan, true);
    assert.equal(Object.hasOwn(readback, "prompt_matches_repo"), false);
    await assert.rejects(runAgentUpdate("apply", h.options), /already applied/);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});

test("apply and readback refuse caller-supplied scopes before provider requests", async () => {
  const h = harness(); try {
    for (const mode of ["apply", "readback"]) await assert.rejects(runAgentUpdate(mode, { ...h.options, scope: "permission-only" }), /scope.*plan/i);
    assert.equal(h.state.calls.length, 0);
  } finally { h.close(); }
});

test("a changed scope cannot reuse a plan hash", async () => {
  const h = harness(); try {
    disablePromptPermission(h);
    await runAgentUpdate("plan", { ...h.options, scope: "permission-only" }); h.review();
    const prepared = h.read("plan.json"); prepared.plan.scope = "full";
    writeFileSync(join(h.root, "private/agent-update/plan.json"), JSON.stringify(prepared));
    await assert.rejects(runAgentUpdate("apply", h.options), /Plan hash/);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 0);
  } finally { h.close(); }
});

test("a full plan cannot reuse permission-only review", async () => {
  const h = harness(); try {
    disablePromptPermission(h);
    await runAgentUpdate("plan", { ...h.options, scope: "permission-only" }); h.review();
    // Produce a valid broader plan through the public command while keeping
    // the earlier permission-only approval. The exact review must not carry.
    await runAgentUpdate("plan", h.options);
    await assert.rejects(runAgentUpdate("apply", h.options), /fresh ship review/);
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 0);
  } finally { h.close(); }
});

for (const fault of ["agent-drift", "account-drift", "unmanaged-permission"]) {
  test(`permission-only update retains the ${fault} guard`, async () => {
    const h = harness(); try {
      disablePromptPermission(h);
      await runAgentUpdate("plan", { ...h.options, scope: "permission-only" }); h.review();
      if (fault === "agent-drift") h.state.agent.conversation_config.agent.prompt.prompt = "Changed after review";
      if (fault === "account-drift") h.state.account.workspace_id = "other_workspace";
      if (fault === "unmanaged-permission") {
        const original = h.options.fetcher;
        h.options.fetcher = async (url, init) => {
          const result = await original(url, init);
          if (init.method === "PATCH") h.state.agent.platform_settings.overrides.conversation_config_override.agent.prompt.llm = true;
          return result;
        };
      }
      await assert.rejects(runAgentUpdate("apply", h.options), fault === "unmanaged-permission" ? /Unmanaged agent settings changed/ : /drifted|identity changed/);
      assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, fault === "unmanaged-permission" ? 1 : 0);
      if (fault === "unmanaged-permission") assert.equal(h.read("journal.json").state, "intent");
    } finally { h.close(); }
  });
}

test("uncertain permission-only PATCH reconciles by saved scope without updating the prompt", async () => {
  const h = harness(); try {
    disablePromptPermission(h);
    await runAgentUpdate("plan", { ...h.options, scope: "permission-only" }); h.review(); h.state.patchFailure = true;
    await assert.rejects(runAgentUpdate("apply", h.options), /private raw evidence/);
    await assert.rejects(runAgentUpdate("apply", h.options), /uncertain/);
    await assert.rejects(runAgentUpdate("plan", h.options), /uncertain/);
    await runAgentUpdate("readback", h.options);
    assert.equal(h.read("journal.json").state, "done");
    assert.equal(h.read("journal.json").scope, "permission-only");
    assert.equal(h.read("journal.json").reconciled, true);
    assert.equal(h.state.agent.conversation_config.agent.prompt.prompt, "Old conversation prompt");
    assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 1);
  } finally { h.close(); }
});

for (const scope of [undefined, "unexpected"]) {
  test(`saved plan with ${scope === undefined ? "missing" : "unknown"} scope fails instead of defaulting to full`, async () => {
    const h = harness(); try {
      await runAgentUpdate("plan", h.options);
      const prepared = h.read("plan.json");
      if (scope === undefined) delete prepared.plan.scope; else prepared.plan.scope = scope;
      writeFileSync(join(h.root, "private/agent-update/plan.json"), JSON.stringify(prepared));
      await assert.rejects(runAgentUpdate("apply", h.options));
      assert.equal(h.state.calls.filter(c => c.method === "PATCH").length, 0);
    } finally { h.close(); }
  });
}
