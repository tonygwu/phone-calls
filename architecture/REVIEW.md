# Architecture review

## Earlier evidence audit

The independent [evidence audit](../docs/reviews/architecture-evidence.md) found that the client was marked verified despite pending connections, and that thirteen source symbols were placeholders. At that stage, the model marked the production client and its exchanges proposed, cited actual functions or document paths, and regenerated all views. The later deployment evidence refresh below supersedes those proposed-state labels. The final source-token audit and model validator must both pass; structural validation alone is not evidence of symbol existence.

## Flow audit

The independent [flow audit](../docs/reviews/architecture-flow.md) found conflated provider/client payloads, omitted synchronous admission checks and incorrect universal retry wording. The model now distinguishes raw ElevenLabs conversation, raw Twilio call state, admission facts and the owner-facing result. It shows admission reads, explains that a new call ID follows those checks and persistence, and distinguishes never-retried dialing from repeated termination requests. Table cards include the durable observation counter and identify aggregate amounts as accounted costs or reservations.

The audit also reproduced expired-result exposure through a duplicate start. Both duplicate branches now reject expired content without waiting for the purge alarm. The committed delayed-alarm regression test failed before the change and passes afterward.

## Operations and AI audit

The fresh [implementation review](../docs/reviews/implementation-review.md) also served as the operations and AI audit. Its initial verdict was `fix-first`. It reproduced stale-response budget regression, unsafe fallback routing and watchdog delay behind terminal recovery. Durable observation sequence numbers now reject older responses; provisional costs retain reservations and charges cannot automatically decrease. Runtime preflight requires empty voice and SMS fallback routes. Active calls defer terminal recovery, and otherwise only one background task runs per alarm. Regression tests cover each finding.

At that local-only stage, both conversational and analysis models were selected as GPT-4.1 Mini and live identity, voice, behavior and client connections were unverified. Provider provisioning later rejected that analysis selection; the deployed analysis configuration uses Gemini 2.5 Flash while conversation remains GPT-4.1 Mini. Subsequent readbacks, client checks and evaluations supersede the old unverified labels. See docs/EVALUATION.md for those results.

## Verification

The canonical model is validated with the skill's architecture CLI. The generated guide, data cards and session panels were inspected against the model. Portable Mermaid, FigJam, D2 and LikeC4 sources are provided. No local LikeC4 renderer was installed, so there are no PNG renders and no claim of rendered-image verification. No model or source has been uploaded to an external canvas.

## Deployment and evaluation evidence refresh

This scoped update replaces stale proposed-state labels using authenticated readiness, client evidence, provider readbacks, the recipient-confirmed voicemail, and all eleven simulation attempts. Component wiring, payload contracts, storage schema and retry policies are unchanged. The generated guide, sources and agent panels were rebuilt from the model. Validation returned valid:true with no errors or warnings. No local PNG renderer is installed; the manifest reports renderer_used:none and no image claims are made.

Evidence audit and disposition: pending scoped review. Ordinary-destination deployment is tracked separately and is not inferred from this model update.


### Scoped independent evidence audit

Verdict: **fix-first**, limited to the deployed-prompt evidence gap below. The lifecycle promotions, primary-client connections, voicemail acceptance and simulation totals have evidence. The model must not represent the tested candidate prompt as deployed until the separately reviewed rollout supplies an exact provider readback. This review authorizes no external change.

This pass compared `private/ordinary-rollout/architecture-before.jsonl` and `architecture-report-before.md` with the current model, report and generated bundle. It inspected the named readiness, client and voicemail evidence, all eleven sanitized simulation records and transcripts, and the relevant local agent definition. It issued no external request and read no credential file.

**Open finding: distinguish the tested prompt from the deployed prompt.** The refreshed `voice-agent` record is now existing and verified, with an unqualified `src/agent.ts AGENT_PROMPT` reference. That source contains the new caller-role, transfer-disclosure and exact-message instructions at lines 5–16. `docs/EVALUATION.md:31` says the tested prompt still awaits a separate deployment review. The passing simulation records used candidate overrides, and the recorded readiness result still has `test_destinations_only: true`. Those facts establish a deployed agent and a tested candidate, but not that this exact candidate is deployed. Severity: medium; confidence: high. Close this finding by comparing the complete post-rollout provider prompt readback with the candidate, confirming the expected agent identity and new configuration hash, and citing that evidence. Until then, qualify the prompt reference as a candidate. The primary agent elected to retain this finding open while the separate rollout proceeds rather than change the model temporarily.

**Review-ledger correction, closed:** the earlier review paragraphs used current tense for historical facts. They said the client remained proposed, both models were GPT-4.1 Mini, and all served-model, voice and client evidence remained pending. The refreshed client evidence contradicts those statements; `src/agent.ts:41,60` configures GPT-4.1 Mini for conversation and Gemini 2.5 Flash for analysis. The primary agent qualified those paragraphs as historical and described the subsequent deployment evidence. I reread the corrected text and closed this finding. This changed the review record, not system design.

The following claims held under challenge:

- Four components and three flows changed from proposed to existing: client, Access, Twilio, telephone agent, request, return and login. No record was added or removed. Endpoint direction, kind, transport, payload references, fields, tables, store references and retry policy were unchanged from the supplied baseline.
- The readiness evidence reports `ok: true`, `ready: true`, no active call and test-only destinations. It therefore supports the already deployed service without claiming ordinary destinations are enabled.
- The client evidence records successful primary Codex, ChatGPT and Claude Code authentication/readiness. The additional b, c and e profiles remain registered but unauthenticated. The model and generated guide preserve this distinction.
- The voicemail record says `accepted_by_recipient`, records one attempted and one accepted call with no failures, and preserves the owner's confirmation that the full message arrived once. The public API still uses `voicemail_attempted`; owner confirmation is separate evidence.
- All eleven simulation summaries matched the corresponding transcript case, manual verdict, failure category and raw-response hash. Six were accepted and five failed. The retained failures are two caller-role errors, one unsupported tone operation, one unrelated follow-up and one incomplete message. Thirty-seven generated events identify GPT-4.1 Mini. Seeded history is explicitly marked and was not counted as generated behavior.
- The reports qualify the simulations as examples across prompt revisions rather than a reliability estimate. Keypad delivery, acoustic hold timing and production booking/support outcome extraction remain unverified. The current local-test count is documented as 62 in `docs/EVALUATION.md:19`; this label-only audit did not rerun the implementation tests.

Verification command:

```sh
python3 /Users/tonygwu/.codex/skills/software-architecture/scripts/architecture.py validate architecture/model.jsonl --source-root . --json
```

Actual result: `"valid": true`, `"errors": []`, `"warnings": []`.

An independent `architecture.py bundle architecture/model.jsonl --output-dir <temporary-directory> --renderer none` run regenerated the portable artifacts into a disposable directory. A byte-for-byte comparison of every file listed in the existing manifest returned:

```json
{
  "generated_files_checked": 25,
  "mismatches": [],
  "renderer_used": "none",
  "renders": []
}
```

Artifact comparisons attempted: 25; succeeded: 25; failed: 0. Simulation-summary/transcript comparisons attempted: 11; succeeded: 11; failed: 0. These are consistency checks, not new simulation runs. No PNG or external-canvas verification is claimed.


### Final scoped verdict after deployment readback

Verdict: **ship**. The prompt-identity finding above is **closed**. This verdict supersedes the earlier fix-first verdict and pending review status. It covers the architecture evidence refresh only; it does not turn the recorded behavioral examples into a reliability guarantee or authorize another call.

I independently compared `private/ordinary-rollout/after.raw.json` with the current `AGENT_PROMPT` and desired agent definition. The recorded live GET names the same agent as both readiness snapshots, identifies its main branch, and has version `agtvrsn_7501m5td1k4det7vr9fn7echmx0q`. The complete prompt matches the source exactly. The full configuration hash, recomputed using `agentHash`, is `42d53842fe870a17567a80c96cbc4a1a828f1a8221765b9acffe1ed595f5e28a`. The conversation and platform settings also match the desired source configuration. This closes the previous gap between the tested candidate and the deployed prompt.

The recorded Worker version is `f7c325dc-85a0-4974-9d50-c57855709c7c`, deployed at `2026-10-25T20:47:12.688924Z`. The Worker and version timestamps agree. The post-deployment readiness response reports `ready: true`, `test_destinations_only: false` and no active call, with the same managed agent, account and caller as before. The captured history contains only the original completed voicemail call. These checks use saved provider responses; this review sent no external request, read no credentials and placed no call.

The independent artifact-verification command was `node --import tsx --input-type=module` with assertions against the named JSON files, `AGENT_PROMPT`, `agentDefinition`, `agentHash` and `assertSubset`. It exited 0 and returned:

```json
{
  "promptExactMatch": true,
  "expectedAgent": true,
  "mainBranch": true,
  "agentVersion": "agtvrsn_7501m5td1k4det7vr9fn7echmx0q",
  "agentHash": "42d53842fe870a17567a80c96cbc4a1a828f1a8221765b9acffe1ed595f5e28a",
  "configurationSubsetMatch": true,
  "workerVersion": "f7c325dc-85a0-4974-9d50-c57855709c7c",
  "deployedAt": "2026-10-25T20:47:12.688924Z",
  "ready": true,
  "testDestinationsOnly": false,
  "activeCalls": 0,
  "historyCalls": 1,
  "originalCallOnly": true,
  "recordedHttpChecks": { "attempted": 9, "succeeded": 9, "failed": 0 }
}
```

The HTTP counts above are from the recorded deployment verification, not a new HTTP run by this auditor. The model now cites the deployed agent readback, and the report explicitly describes the corrected prompt as deployed. I reran:

```sh
python3 /Users/tonygwu/.codex/skills/software-architecture/scripts/architecture.py validate architecture/model.jsonl --source-root . --json
```

Actual result: `"valid": true`, `"errors": []`, `"warnings": []`. A fresh temporary bundle and byte comparison returned `"generated_files_checked": 25`, `"mismatches": []`, `"renderer_used": "none"`, `"renders": []`. Artifact comparisons attempted: 25; succeeded: 25; failed: 0. No implementation tests or external checks were added. No findings remain open in this scoped refresh.
