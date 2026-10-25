# Review of final-price evidence

Verdict: **ship**. Findings: **0 blockers, 0 must-fix, 0 should-fix, 0 nits**. The earlier finding is closed: a terminal response without a price cannot turn a provisional price into final evidence. The allowance and reconciliation remain active until both providers have supplied a terminal price.

This is the additional scoped review authorized by the user's instruction to continue the original plan. It applies the `adversarial-self-review` skill. The request is `docs/REQUEST.md`; `docs/reviews/fix-review.md` was read verbatim. The review verifies that report's remaining finding and attacks only this new diff and its regressions. It does not reopen the whole repository review.

No implementation file was edited. All provider responses were simulated. No secrets or private configuration were inspected, and no browser, account mutation, live call, model request or deployment was attempted.

## Artifact identity and scope

There is no Git repository in this directory. The exact baseline is `/var/folders/rl/fd44k0053xq4qzrnx27t3p0m0000gn/T/phone-before-final-price-9xu15_hf`. Recomputing the SHA-256 of every file against its `files.json` produced:

```text
BASELINE_IDENTITY_OK 8
```

The review compared all eight baseline entries. Seven changed: three implementation files, one test file, README and two operation/evaluation documents. `test/providers.test.ts` is unchanged. Current reviewed identities are:

```text
a93f0803ced0817628d1e3a3c9b9c3fa0ece388e50adabe9d907c2b8e401ec43 src/contracts.ts
370b232470cb05ef6a1ad97aa2b58ea88e7694cb635e9159415a888b5fe7a771 src/providers.ts
e93e0024e1060126238216f5ba14db974b06b0ec11dc184e337bfb0fd8e6666d src/engine.ts
ecd7cbc0aee643666075f5edd77114a3189900a0aedf7cf588aaead50fa19638 test/engine.test.ts
4cf5b5119bc3494c9d4e06c4407bc2a83874814f72cd6dbd8cc652b9110aab33 test/providers.test.ts
81c92f2e7d40a734d16a9827ae62907663fa9834078449f0d361841e793f1107 docs/OPERATIONS.md
bd7e5d6544be253b29e4ce789428687046449b614d1014d1ffeca91cbe96442f docs/EVALUATION.md
305ba2361cc2da63ea86c7b85b19b419b014e439ada32796a013edbc6f01c840 README.md
```

The relevant request clauses and the prior finding map to this diff as follows:

1. Track incurred charges and reserved allowances against the $10 budget: `src/contracts.ts:58-68` adds separate final-price evidence and requires both providers' evidence in `costsSettled`. The unchanged `src/store.ts:39-42` uses that predicate for allowance accounting.
2. Surface unknown costs before spending: `src/providers.ts:147-150` and `src/providers.ts:175-178` set final-price evidence only when that same accepted response contains a non-null price and terminal status. The unchanged public view uses the shared predicate. The new tests also verify rejection of a second call when retained allowances would exceed $10.
3. Reconcile missing results through provider APIs: `src/engine.ts:153` now uses the same settlement predicate before ending reconciliation. The new cases verify continued polling and later settlement.
4. Preserve reproducible evidence and operations guidance: `test/engine.test.ts:55-89` covers both providers; the three changed documents explain the remaining reservation and pending external rollout.

## Findings

None.

The prior must-fix is closed for both ElevenLabs and Twilio. Each new regression case covers a provisional price, a terminal response with a null price, continued reservation and polling, rejection of excess spending, later final-price arrival, and preservation of final evidence across subsequent null responses. The earlier overlap test now obtains the Twilio price through the real provider transformation instead of assigning the amount directly, which is necessary to establish the new evidence field.

## Commands and actual evidence

The first `npm run check` from the source directory completed TypeScript checking but the sandbox prevented Cloudflare test workers from binding a local port. Exit 1 contained:

```text
Error: listen EPERM: operation not permitted 127.0.0.1
Test Files  no tests
Tests       no tests
Errors      4 errors
```

These are four `sandbox_loopback_denied` startup errors, not product assertion failures. Subsequent test invocations used the permitted local-loopback execution path.

For the baseline test, the reviewer created `/var/folders/rl/fd44k0053xq4qzrnx27t3p0m0000gn/T/phone-final-price-review-baseline-s9rjv7ug` with current source and tests, then replaced only the three changed implementation files with their verified baseline versions. Dependencies were linked from the source checkout. No private configuration was copied. Command from that directory:

```sh
npm test -- test/engine.test.ts -t 'ends without a final price' --reporter=verbose
```

Actual output, exit 1:

```text
× keeps polling and reserving budget when ElevenLabs ends without a final price
× keeps polling and reserving budget when Twilio ends without a final price
AssertionError: expected 24000 to be 400000 // Object.is equality
-   "status": "unsettled",
+   "status": "provider_reported",
AssertionError: expected 1795496400000 to be 1792904460000 // Object.is equality
AssertionError: promise resolved "{ …(18) }" instead of rejecting
Test Files  1 failed (1)
Tests       2 failed | 32 skipped (34)
```

Both tests therefore detect the earlier defect. Each baseline case fails the allowance, public cost status, next-check time and excess-budget rejection assertions. The 32 other engine cases were explicitly excluded by the test-name filter; no sampling was used within either selected case.

For current-code verification, the reviewer created `/var/folders/rl/fd44k0053xq4qzrnx27t3p0m0000gn/T/phone-final-price-review-current-jcn6zjnl` with the source, tests and public build/test configuration. This avoids loading the checkout's private environment file. Command from that directory:

```sh
npm run check
```

Actual output, exit 0:

```text
> tsc --noEmit
✓ test/providers.test.ts (10 tests)
✓ test/mcp.test.ts (1 test)
✓ test/engine.test.ts (34 tests)
✓ test/security.test.ts (6 tests)
Test Files  4 passed (4)
Tests       51 passed (51)
> cf build
No lock file has been detected in the current working directory.
✓ 265 modules transformed.
.cloudflare/output/v0/workers/default/bundle/index.js  1,156.49 kB
✓ built in 62ms
◆  Build complete
```

The disposable copy intentionally reused installed dependencies and omitted the lockfile, producing the quoted build warning. It did not install or change dependencies. A byte-for-byte comparison of all copied source files, existing test files and public configuration against the working source returned:

```text
REVIEWED_COPY_MATCHES_SOURCE 20
```

The reviewer then added one disposable test file only in that isolated copy. It uses the actual `CallEngine`, provider transformations and SQLite `SqlStore`, with simulated provider responses. Command:

```sh
npm test -- test/final-price-review.test.ts --reporter=verbose
```

Actual output, exit 0:

```text
✓ accepts explicit zero prices for 'done' and 'completed'
✓ accepts explicit zero prices for 'done' and 'busy'
✓ accepts explicit zero prices for 'done' and 'no-answer'
✓ accepts explicit zero prices for 'done' and 'canceled'
✓ accepts explicit zero prices for 'done' and 'failed'
✓ accepts explicit zero prices for 'failed' and 'completed'
✓ accepts explicit zero prices for 'failed' and 'busy'
✓ accepts explicit zero prices for 'failed' and 'no-answer'
✓ accepts explicit zero prices for 'failed' and 'canceled'
✓ accepts explicit zero prices for 'failed' and 'failed'
✓ keeps ElevenLabs final evidence separate across store recreation
✓ keeps Twilio final evidence separate across store recreation
✓ cannot finalize from stale, duplicate or later nonterminal responses
✓ retains the largest reported charge while finalizing later lower prices
Test Files  1 passed (1)
Tests       14 passed (14)
```

Current suite: **51 attempted, 51 succeeded, 0 failed**. Independent probes: **14 attempted, 14 succeeded, 0 failed**. Baseline reproduction: **2 attempted, 0 passed, 2 expected failures**, classified `provisional_price_promoted_to_final`; 32 cases intentionally filtered out. Environment startup failures: **4**, classified `sandbox_loopback_denied`. Live provider evaluations and external mutations: **0 attempted**.

## Attacked and held

- Scope fidelity: mapped the three implementation changes, test updates and documentation to the prior finding and four relevant request clauses. No unrelated refactor, new dependency or configuration change appears in the reviewed diff.
- Evidence provenance: reproduced both failures against baseline, then observed both pass in the complete current suite. Final-price fields are assigned from accepted terminal responses only; a provider's final price cannot substitute for the other provider's missing evidence.
- Shared completion predicate: inspected every `costsSettled`, `CostFinal` and `CostMicros` occurrence in source/tests/docs. Ledger accounting, public cost status and reconciliation completion use the same predicate. The existing zero-cost `not_dispatched` exception remains limited to calls never sent.
- Persistence: recreated both `SqlStore` and `CallEngine` before and after final-price arrival for each provider. Missing evidence retained 400,000 microdollars; completed evidence retained 24,000 microdollars through later null responses and further recreation.
- Response ordering: independently supplied stale, duplicate and newer nonterminal responses after terminal-null snapshots. None set a final-price flag. A newer priced terminal response then settled the charges.
- Edge values and terminal states: tested explicit zero prices for all ten combinations of the two ElevenLabs terminal states and five Twilio terminal states. Zero is accepted as evidence; null remains unknown. Existing tests cover canceled pending calls without final-price flags.
- Conservative accounting: tested a 650,000-microdollar provisional total followed by zero terminal prices. Final evidence becomes available but the largest observed amount remains accounted, consistent with the existing documented rule that charges do not automatically decrease.
- Silent fallbacks: no new catch-and-default branch was added. Missing final-price flags cannot satisfy an explicit `=== true` check. The existing amount default is used only while applying a supplied non-null price, and cannot itself establish final evidence.
- Decisions and limits: final-price evidence is sticky after it is obtained; later null responses do not erase it. Existing conservative maximum-charge accounting remains unchanged. No new sampling, timeout, quota cap or polling interval was added. Stricter completion retains the existing minute/hour recovery schedule until settlement or retention expiry.
- Time: the new logic introduces no timestamp or filesystem-time comparison. Tests use the existing fixed UTC fixture. Source identities were checked with content hashes and byte comparisons, not file modification time.
- Documentation: searched the changed final-price terms across README, operations, evaluation, source and tests. The prose states both the retained allowance and continued polling, and continues to distinguish simulated checks from live acceptance.
- Blast radius: the new fields serialize in the existing task JSON; there is no schema migration, dispatch retry, routing, authentication or deployment-command change. This scoped code verdict does not claim live provider readiness or voicemail delivery.

## Verdict

**ship**, with **0 blockers, 0 must-fix, 0 should-fix and 0 nits**. The remaining final-price finding is closed and no regression was found in this authorized scoped review.
