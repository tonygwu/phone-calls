# Review of the implementation fixes

Verdict: **fix-first**. Findings: **1 must-fix, 0 blockers, 0 should-fix, 0 nits**. The earlier response-ordering, expiry, routing, watchdog and architecture defects are corrected in their reproduced cases. A further scenario against the new provisional-cost settlement logic still releases the budget allowance before final price evidence exists.

This is the second review of this unit. It is scoped to the earlier findings and the fix diff, including regressions the fixes introduce. It does not reopen the whole repository review. The request is `docs/REQUEST.md`; the earlier reports were read verbatim from `docs/reviews/implementation-review.md`, `architecture-evidence.md`, and `architecture-flow.md`.

No implementation file was modified. No private configuration or `.dev.vars` was read. All provider responses were simulated. No account mutation, deployment, client connection or paid call was attempted.

## Artifact identity

The baseline is `/tmp/phone-before-review-fixes-h1ac_npj`. A SHA-256 check of every entry in its `files.json` returned:

```text
BASELINE_IDENTITY_OK 62
```

The review compared its `src`, `scripts`, `test`, `docs`, and `architecture` trees with the current files. The implementation and test changes are four source files, one preflight output-label change, and two test files. Related operation/evaluation prose, evidence, canonical architecture and generated views also changed. Current key identities are:

```text
dd48aff8c55c2921991a2cfa8075d5c9e7b79d7be0e3c3deacca6b11ecfd6630  src/contracts.ts
76291ae098c7b5ea8bcc37d6cb966715abe096ea8051201a8c4676a934fb7d21  src/engine.ts
92112c6cd7570d5d0f62e88ec94a1513bad501cff6068090000352d077c32494  src/providers.ts
e6fd324920a20e69caa2acd0a6cf04f4bef73d88b6e1664144926e159426f05f  src/store.ts
c931cf23956b2bb492b471348cc0fc71db17caa5e22eef04bccc1e485b003f8d  scripts/preflight.mjs
0833161e2edd7d71beaea7b7db9f165ae0a3b40cb32eb0c5a500a5d3e9c44f29  test/engine.test.ts
4cf5b5119bc3494c9d4e06c4407bc2a83874814f72cd6dbd8cc652b9110aab33  test/providers.test.ts
b27b86ac805702fd5d378cf3a36d732399e5c769732186a88190ebb916143575  architecture/model.jsonl
ca0267eb52c2f3ffb2c0bbba3cd5a370f744aa0b2c6ad1a2aa246e8d3ea8cdb9  architecture/REPORT.md
```

## Ranked finding

### 1. Must-fix: terminal state can turn an earlier provisional price into supposedly final evidence

Location: `src/contracts.ts:64-65`, `src/providers.ts:137-149`, `src/store.ts:39-41`, and the completion predicate at `src/engine.ts:153-154`.

The request requires unknown costs to remain visible and outstanding allowances to count against the $10 budget. The new `costsSettled` predicate checks terminal provider state and the presence of price fields. It does not check whether each price was obtained with terminal evidence. `applyConversation` retains an earlier price when a later response has `cost_fiat: null`. Consequently, a final response can make an earlier provisional price satisfy `costsSettled`.

The reproduction uses the actual `CallEngine`, `SqlStore`, and provider transformation functions with in-memory SQLite:

1. Accept a task with a 400,000-microdollar allowance.
2. Apply an ElevenLabs `processing` response with `cost_fiat: 0.01` and a Twilio `completed` response with a known $0.014 charge. The allowance correctly remains 400,000 microdollars.
3. Run actual `CallEngine.reconcile`. Twilio still reports its known final $0.014 charge. ElevenLabs now reports `done`, a transcript, and `cost_fiat: null`.
4. Accounting drops to 24,000 microdollars, the public result says `provider_reported`, and reconciliation stops polling until retention expiry. The only ElevenLabs price evidence is still the earlier processing value.
5. With fixed monthly costs set to $9.50, another $0.40 call is admitted. Retaining the first allowance would instead reject it because $9.50 + $0.40 + $0.40 exceeds $10.

Command:

```sh
./node_modules/node/bin/node --import tsx /tmp/phone-fix-review-provisional-cost.mts
```

Actual output, exit 1:

```json
{"probe":"terminal_null_prices_reuse_provisional_costs","before_terminal_micros":400000,"after_terminal_micros":24000,"result_cost_status":"provider_reported","second_call_accepted":true,"next_check_equals_expiry":true,"error":null}
```

```text
AssertionError [ERR_ASSERTION]: Unsettled terminal costs must retain the reservation
24000 !== 400000
```

The sibling Twilio transformation also retains earlier prices when a terminal read has a null price. This is the same evidence-provenance problem in the new shared settlement predicate. The independently reproduced final scenario above needs only a provisional ElevenLabs price; it does not depend on Twilio returning a provisional active-call price.

Proposed fix: persist final-price evidence separately for each provider, retain the allowance and continue polling until that evidence exists, and test provisional-price followed by terminal-null-price sequences.

## Earlier finding dispositions

| Earlier finding | Disposition and evidence |
| --- | --- |
| Older overlapping response lowers settled spending and overwrites newer results | Corrected for both older `processing` and older `done` responses. The current overlap tests retain 1,014,000 microdollars, retain the final summary, and reject excess budget admission. Both tests fail against baseline. The new settlement helper has the separate defect above. |
| Duplicate start exposes expired content before purge | Corrected. The committed test fails against baseline and passes now. An independent probe also inserts an expired duplicate during preflight and confirms the second duplicate branch rejects `REQUEST_EXPIRED`. |
| Unsafe voice or SMS fallback routes pass readiness | Corrected. Each fallback is independently rejected with `ROUTING_UNSAFE`. Both tests fail against baseline and pass now. Required schema fields also prevent absent fallback readback from silently disappearing. |
| Production client falsely marked existing/verified | Corrected. Client and request/return exchanges are proposed. Generated guide states the client is proposed. Local server evidence is no longer presented as a completed client connection. |
| Thirteen absent source symbols and weak Twilio locator | Corrected. Source-token audit checks all 35 evidence records and reports no missing symbols. Reviewed replacements name the relevant functions, constants, schemas or document paths. |
| Raw provider data conflated with owner-facing results | Corrected. Raw conversation, Twilio call, admission facts and owner-facing result have separate entities. Voice-agent output and the conversation-read flow use the raw conversation. Result use is limited to the owner response. Brief and initiation cards include task type, success criteria, nesting and JSON-encoded arrays. |
| Synchronous admission dependencies omitted | Corrected. Both provider admission flows and their seven-read payload are present. Report and overview explain that checks, task persistence and alarm scheduling precede the new-call response. |
| Universal no-POST-retry claim copied onto termination/recovery | Corrected. Initiation is never retried; hangup may repeat pending confirmation; reads and terminal recovery have separate cadence descriptions. |
| Terminal polling delays an already-active watchdog | Corrected in the reproduced case. The overdue active task is processed while terminal recovery is deferred. The current watchdog and alarm-scheduling tests both fail against baseline. Existing in-flight background requests remain a documented limit. |

## Commands and actual evidence

The first sandboxed `npm run check` completed TypeScript checking but could not start four Cloudflare test workers. Actual diagnostic was `Error: listen EPERM: operation not permitted 127.0.0.1`, with `Test Files no tests`, `Tests no tests`, and `Errors 4 errors`. These were environment startup failures, not assertion failures.

The permitted local-loopback rerun of the same command exited 0:

```text
> tsc --noEmit
Test Files  4 passed (4)
Tests       49 passed (49)
> cf build
✓ 265 modules transformed.
.cloudflare/output/v0/workers/default/bundle/index.js  1,151.01 kB
✓ built in 51ms
◆ Build complete
```

To verify that the tests can detect the old defects, the reviewer copied baseline `src/`, current `test/`, and the current test configuration into a disposable directory. The repository's implementation was not reverted. Command from that directory:

```sh
npm test -- --reporter=dot
```

Actual output:

```text
Test Files  2 failed | 2 passed (4)
Tests       8 failed | 41 passed (49)
```

All eight added cases failed against baseline: older processing response, older completed response, provisional allowance, deferred-background alarm scheduling, watchdog priority, expired duplicate, voice fallback and SMS fallback. Representative actual failures were `expected 24000 to be 1014000`, `expected 24000 to be 400000`, `expected "vi.fn()" to be called 1 times, but got 0 times`, and a duplicate request resolving with `"summary": "Private result"`. This independently supports the historical six-regression claim and also verifies the two tests added afterward.

Additional targeted probe command:

```sh
./node_modules/node/bin/node --import tsx /tmp/phone-fix-review-probes.mts
```

Actual final output:

```json
{"probe":"durable_observation_after_store_recreation","sequence":3,"status":"passed"}
{"probe":"final_state_and_charge_monotonicity_both_providers","eleven_cost_micros":1000000,"twilio_cost_micros":28000,"accounted_micros":1028000,"status":"passed"}
{"probe":"expiry_on_second_duplicate_branch","error":"REQUEST_EXPIRED","status":"passed"}
{"probe":"expiry_before_active_selection_and_bounded_background_progress","background_calls_after_two_ticks":2,"next_alarm":1792904460000,"safety_block":"RETENTION_UNRESOLVED","status":"passed"}
{"attempted":4,"succeeded":4,"failed":0,"error_taxonomy":{}}
```

An earlier version of the last diagnostic fixture changed only the JSON expiry of an existing row, leaving the intentionally immutable indexed expiry unchanged. It failed with an alarm-time mismatch. Correcting the fixture to insert an expired row made the probe pass without an implementation change. That attempt is classified `diagnostic_fixture_inconsistent_expiry`, not a product defect.

Architecture commands:

```sh
python3 /Users/tonygwu/.codex/skills/software-architecture/scripts/architecture.py validate architecture/model.jsonl --source-root . --json
python3 /Users/tonygwu/.codex/skills/software-architecture/scripts/architecture.py bundle architecture/model.jsonl --output-dir /tmp/phone-fix-review-architecture-views --renderer none
```

Actual validation and independent comparison outputs:

```json
{"errors":[],"valid":true,"warnings":[]}
{"evidence_count":35,"missing_symbols":[]}
{"generated_files_compared":25,"different_files":[]}
```

A separate canonical-record comparison returned `GENERATED_DATA_CARDS_MATCH_MODEL 23`. No PNG renderer was run, matching the artifact's explicit limitation.

Current suite: 49 attempted, 49 succeeded, 0 failed assertions. Baseline mutation check: 49 attempted, 41 passed, 8 expected regression failures. Final additional probes: 5 attempted, 4 passed, 1 product-invariant failure classified `provisional_price_promoted_to_final`. Earlier environment failures: 4 `sandbox_loopback_denied`; earlier diagnostic fixture failures: 1 `diagnostic_fixture_inconsistent_expiry`. Live provider tests and external mutations: 0 attempted.

## Attacked and held

- Scope: mapped the changed source, tests and prose to the prior findings and the request's budget, retention, routing, callback-ordering and watchdog requirements. The preflight output rename limits its zero-call claim to that check and is harmless collateral.
- Response ordering: tested overlapping callbacks, later nonterminal snapshots, repeated terminal snapshots and nondecreasing charges for both provider transformations. Durable sequence allocation continued after reconstructing the store.
- Expiry and scheduling: tested both duplicate branches, purge before task selection, an expired active row, retained unresolved-call blocking, one terminal task per tick, and subsequent alarm progress through two background tasks.
- Fallbacks: each unsafe fallback fails independently; the parser requires both readback fields. No permissive parser or new retry fallback was introduced.
- New limits and tradeoffs: one task per alarm bounds background work; all terminal analysis and billing recovery defer while an active call exists. Lower revised prices do not automatically reduce charges, so refunds need operator reconciliation. These choices are stated in operations documentation. They may delay final billing or conservatively block calls.
- Time: ordering uses persisted sequence numbers, not filesystem timestamps or wall-clock comparison. Probe timestamps are fixed UTC data. No new local-time accounting conversion was introduced.
- Architecture consistency: validated structure, inspected repaired evidence references and flow semantics, compared 23 cards with the canonical model, and regenerated all 25 listed view files byte-for-byte.
- Blast radius: the new observation counter is additive local SQLite state. No account provisioning or deployment path changed. Existing external rollout remains pending.

## Verdict and review limit

**fix-first**, with **1 must-fix**. This is the second `fix-first` verdict for this unit. Under the adversarial-self-review skill's two-round cap, the author must ask the operator before continuing the fix/review loop. The recommended next step is to authorize the bounded final-price-evidence fix and one further scoped review. Shipping with the gap would permit underestimated budget accounting and stop final-price reconciliation, so recording it as a known limitation is not recommended.
