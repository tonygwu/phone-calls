# Implementation adversarial review

Verdict: **fix-first**. Findings: **4 must-fix, 1 should-fix, 0 blockers, 0 nits**. The local check passes, but it does not cover the reproduced budget race, expired duplicate-request response, or unsafe fallback routing. Deployment, account setup, client authorization and real behavioral evaluation remain explicitly pending and are not treated as completed work.

This is a fresh review of the whole new local repository against `docs/REQUEST.md`, excluding `node_modules/`, `private/`, `.dev.vars`, and generated `.cloudflare/` files. Source, tests, public configuration, provisioning/deployment scripts, documentation and architecture artifacts were inspected. No Git repository was available. No private instruction source or private task configuration was read. No accounts were changed, no paid provider request was made, and no call was placed. Public ElevenLabs documentation and its public OpenAPI schema were read to check API shapes.

The reviewed source identities, from `shasum -a 256`, are:

```text
a30458a3782a9abf69614c3a7e2b8708abf61d9b995d7b8a908584c238be9446  src/engine.ts
5682d54fc0ab3cc3cca4752e6a844f9674efda0caa54b1a13f44cb61ca8c9388  src/store.ts
1b0edad1e09d9dacb652b7dde1321dadafaec7fd97f35de5a310c4389e9f7b8b  src/providers.ts
b340be3769427f9e8fd86519ce87f1d14ef09e28ac8bef663fc1f3b1a70a0d49  src/ledger.ts
bfa9b7c1b24c6671c0d1a3d76bed006f6d55a02e3870f48967596779f5d8a46f  scripts/provision.ts
534deddf92d6da2d32fa51af3f5138e823e8b20a78516db4a88ba94688c19321  scripts/deploy.mjs
5bdbb258e982df6a236598618f9a6326a430ed8f8a573f3d158d7c148fe665f6  architecture/model.jsonl
637b17f129f66869a174eea2e56e4f9f6d2bf475d68d0f73c0f89b167229985e  architecture/REPORT.md
```

## Ranked findings

### 1. Must-fix: an older conversation response can reduce settled charges

Location: `src/providers.ts:137-144`, `src/engine.ts:169-179`, `src/store.ts:37-39`.

The requirement is to handle out-of-order callbacks and retain reliable incurred costs for the $10 budget. Fetching authoritative data does not order overlapping requests. A callback can start a read while a conversation is processing, then return after a newer read has supplied its completed analysis and final charge. `applyConversation` overwrites the charge before checking conversation status. The store then immediately uses that smaller charge in admission accounting because both provider prices are present.

The reproduction started two callback reads for the same managed task. The later read returned `done` with a $1 ElevenLabs charge. The earlier read then returned `processing` with a $0.01 charge. Twilio's known charge was $0.014 throughout. The actual engine and SQL store reduced accounted spend by $0.99 while retaining the newer summary. A new task can be admitted against that false balance before another alarm repairs it.

Actual output:

```json
{"probe":"stale_processing_response_reduces_settled_cost","accounted_after_done_micros":1014000,"accounted_after_stale_processing_micros":24000,"summary":"Final"}
```

Fix: order or serialize per-call reconciliation and preserve final-state/cost evidence against older snapshots; add an overlapping-response regression test that checks budget admission as well as retained results.

### 2. Must-fix: repeating a start request returns expired private results

Location: `src/engine.ts:14-18` and `src/engine.ts:27-30`, contrasted with `src/engine.ts:41-44`.

The requirement is 30-day retention for task details and results. If the alarm is delayed, an expired row still exists. Normal get correctly rejects it, but both duplicate-request branches return `view(existing)` without checking expiry. The view exposes summary, confirmation, unresolved questions, provider identifiers and a recording URL. The recording route itself still rejects expired content.

The independent flow review found this defect, and this review reproduced it using production `CallEngine` and `SqlStore` with SQLite. No provider method was called by the duplicate start. Actual output at the expiry boundary:

```json
{"probe":"expired_duplicate_request","direct_get_error":"CALL_NOT_FOUND","duplicate_start_summary":"PRIVATE SUMMARY AFTER RETENTION","expires_at":"2026-11-24T05:00:00.000Z","now":"2026-11-24T05:00:00.000Z"}
```

Fix: apply the expiry guard in both duplicate branches before constructing a view, and test a retry after expiry without first executing the purge alarm.

### 3. Must-fix: readiness accepts Twilio fallback routes that can receive calls or SMS

Location: `src/providers.ts:74`, `src/providers.ts:81`; compare `scripts/provision.ts:30` and `docs/DEPLOYMENT.md` step 8.

The requirement is outbound-only operation with rejected inbound voice and no SMS conversations. Provisioning clears the voice and SMS fallback URLs, and the deployment instructions require checking them, but runtime preflight omits both fields from its schema and readiness predicate. Zod removes the unrecognized fields before validation. If either route later changes, readiness still passes. If the primary inbound webhook fails, Twilio may execute the configured voice fallback instead of the intended rejection.

A simulated Twilio number readback contained the required rejecting primary route plus `voice_fallback_url: https://unsafe.example.com/accept-inbound` and `sms_fallback_url: https://unsafe.example.com/receive-sms`. All identities and the agent hash matched. Actual output:

```json
{"probe":"unsafe_fallback_routes","accepted":true,"reservationMicros":362000,"unsafe_fallback_count":2}
```

Fix: require and validate both fallback fields as empty, alongside the primary routes, and test each independently.

### 4. Must-fix: architecture claims need correction before the artifacts are called complete

Location: `architecture/model.jsonl:2` and its flow/evidence records; generated views and cards; `architecture/REPORT.md`.

The implementation is locally present, but the canonical model marks the production MCP client existing and verified using the server factory as evidence. Client registration is explicitly pending elsewhere. Thirteen evidence locators name absent symbols. The model also labels a raw provider conversation with the owner-facing result schema, omits seven synchronous admission reads, and copies the no-dial-retry statement onto hangup flows that do repeat termination POSTs.

These are source-supported documentation defects, not failures to deploy without credentials. The two completed architecture reviews give exact locations and corrections: `docs/reviews/architecture-evidence.md` and `docs/reviews/architecture-flow.md`. I checked their claims against the current source. The configured conversation and analysis models are GPT-4.1 Mini; served identity remains unobserved. That distinction is correctly stated in the prose and should remain.

Fix: correct client lifecycle, source symbols, payload provenance, admission dependencies and per-flow retry descriptions, then regenerate the architecture artifacts and record the independent audit results.

### 5. Should-fix: slow terminal-call polling delays an overdue active watchdog

Location: `src/engine.ts:46-52`, `src/store.ts:46`, `src/providers.ts:53`.

The due-task loop orders work only by its next-check time and awaits each task sequentially. A terminal task awaiting a price or analysis can therefore hold an overdue active call behind one or two 15-second provider requests. Several old terminal tasks multiply that delay. The separate ElevenLabs duration limit reduces the risk, so this finding is bounded and lower priority than the correctness defects above. It still weakens the independent Twilio watchdog during provider degradation.

The reproduction stored an old terminal task and an active task already past its deadline. It held the old task's provider read pending, then released it. Actual output:

```json
{"probe":"terminal_poll_blocks_watchdog","active_over_deadline":true,"terminations_while_old_request_pending":0,"provider_calls_started":1}
{"probe":"watchdog_after_old_poll_released","terminations":1}
```

Fix: process active calls and due deadlines before terminal analysis/price recovery, or separate their scheduling so finalization cannot hold up termination.

## Requirement coverage

The request was converted to this checklist before assigning the verdict. Pending external steps are named rather than silently counted as implemented acceptance.

| Requirement | Source and assessment |
| --- | --- |
| 1. TypeScript, Zod, official MCP SDK, Cloudflare Streamable HTTP and SQLite durable state | `package.json`, `src/index.ts`, `src/ledger.ts`, `src/store.ts`; locally implemented and exercised. |
| 2. Separate owner-only Access application, in-Worker authentication and no alternate URLs | `scripts/provision.ts:23-28`, `src/auth.ts:7-15`, `src/index.ts:12-14`, `cloudflare.config.ts`; local definitions and authentication tests exist. Deployment is pending. |
| 3. Dedicated US number, secrets, outbound-only routing and authenticated web sessions | `scripts/provision.ts:77-91`, `src/agent.ts:49`, `src/providers.ts:70-87`; local definitions exist; fallback drift defect above. Account readback is pending. |
| 4. Stock English voice, pinned GPT-4.1 Mini, disabled substitution and four phone controls | `src/agent.ts:30-59`; model and tool definitions exist. Stock voice identity, provider normalization and served identity need live readback. |
| 5. Fresh per-call instructions without patching the shared agent | `src/agent.ts:68-87`, `src/providers.ts:100-101`; initiation data only, tested locally. |
| 6. Signed callbacks, persistence before acknowledgement, deduplication, ordering and reconciliation | `src/index.ts:20-27`, `src/auth.ts:27-44`, `src/engine.ts:96-179`; signatures/correlation and persistence present; overlapping response ordering defect above. |
| 7. Thirty-day provider/service retention, authenticated streamed audio and no Twilio recording | `src/agent.ts:50,72`, `src/store.ts:56-65`, `src/ledger.ts:26-30`; provider settings proposed, service purge tested; expired duplicate response defect above. |
| 8. All five specified MCP tools and fields, pagination, durable call ID | `src/contracts.ts`, `src/mcp.ts`, `src/ledger.ts`; actual HTTP MCP dispatch test passes. New starts await admission before returning the ID. |
| 9. Telephone status separate from task outcome and unverified voicemail receipt | `src/engine.ts:181-194`, `src/providers.ts:149-156`; locally enforced and tested. |
| 10. Explicit authorization, supplied facts, disclosure, limited commitments and needs_user_input | `src/mcp.ts:6`, `src/agent.ts:4-28`; prompt/tool contracts implemented. Model behavior is not evaluated. |
| 11. Voicemail timing, once-only speech, live-person distinction and default no business voicemail | `src/agent.ts:6-10`, required voicemail union in `src/contracts.ts`; prompt contract exists. There is no claimed speech or carrier acceptance. |
| 12. Callback number and constrained information disclosure | `src/agent.ts:12,19,77`; explicit prompt constraint; requires behavioral evaluation. |
| 13. One active call; 180/900/1800-second duration rules; 60-second ringing | `src/engine.ts:20-36`, `src/agent.ts:73,86`; tested locally. |
| 14. Provider duration override plus durable watchdog and provider-confirmed cancellation | `src/engine.ts:114-128`, `src/ledger.ts:13-20`; tested; scheduling delay finding above. |
| 15. Persist before dispatch, preserve ambiguous state, never redial | `src/engine.ts:64-94,99-100`; exercised by actual engine/SQLite tests. |
| 16. Rate, credit, funding and $10 monthly budget checks with explicit unknown costs | `src/providers.ts:66-98`, `src/engine.ts:34-38`, `src/store.ts:37-54`; implemented; stale cost race above. Allowances require current manual verification. |
| 17. Local simulated tests for validation, security, races, recovery, cancellation, limits, budget and retention | Four test files, 41 tests pass. Added adversarial probes expose uncovered defects. |
| 18. Configure accounts, private deployment and full identity/readback review | Scripts and runbook prepared. Explicitly pending credentials and a concrete execution review. No authorization to execute those mutations is inferred from this report. |
| 19. Register Claude Code, ChatGPT and Codex and test tool selection separately | `docs/CLIENTS.md` and client templates prepared. Registrations and OAuth acceptance explicitly pending. |
| 20. Test-number-only initial voicemail evaluation with recipient confirmation | `src/config.ts`, `src/engine.ts:20-21`, `docs/EVALUATION.md`; gating present, live evaluation not run. |
| 21. Conversational scenarios, ordinary-destination rollout and honest counts | `evals/scenarios.json`, `docs/EVALUATION.md`; seven scenarios prepared and marked not run. No real/model successes claimed. |
| 22. Sanitized evidence, operational/client/deployment documentation and architecture | Public evidence and documentation exist; architecture corrections above remain. No task-private files were inspected. |

## Commands and actual results

The first sandboxed `npm run check` invocation typechecked but could not start the local test runtime:

```text
Error: listen EPERM: operation not permitted 127.0.0.1
Test Files  no tests
Tests       no tests
Errors      4 errors
```

The bounded rerun allowed the loopback listener and performed only local simulated tests and a build:

```sh
npm run check
```

Actual output:

```text
> tsc --noEmit

✓ test/providers.test.ts (8 tests) 11ms
✓ test/mcp.test.ts (1 test) 15ms
✓ test/engine.test.ts (26 tests) 80ms
✓ test/security.test.ts (6 tests) 57ms

Test Files  4 passed (4)
Tests       41 passed (41)

> cf build
✓ 265 modules transformed.
.cloudflare/output/v0/workers/default/bundle/index.js  1,148.90 kB
✓ built in 54ms
◆ Build complete
```

The disposable reproduction harness imports the actual `CallEngine`, `SqlStore`, `LiveProviders`, and agent definition. It uses an in-memory native SQLite adapter, synthetic identities and injected provider responses. It does not import or use credentials. It lives at `/tmp/phone-calls-review-repros.mts`; the relevant actual JSON outputs are reproduced with each finding above. Command:

```sh
node_modules/node/bin/node --import tsx /tmp/phone-calls-review-repros.mts
```

Result: exit 0; four adversarial scenarios attempted, four successfully reproduced defects, zero harness failures. The five JSON rows in findings 1, 2, 3 and 5 are observations of bad behavior, not passing correctness tests. The implementation owner should convert these scenarios to failing regression assertions before making fixes.

Runnable suite: 41 attempted, 41 succeeded, 0 assertion failures. Initial environment startup: 4 failures classified `sandbox_loopback_denied`. Live calls: 0 attempted. Model simulations: 0 attempted. External mutations: 0 attempted.

## Attacked and held

- **No automatic redial:** inspected every dispatch call site, reran uncertain-timeout and restart tests, and confirmed only the pending dispatcher sends the outbound call POST.
- **Concurrency admission:** inspected both synchronous checks after network preflight and reran simultaneous-start tests; only one new active task was admitted.
- **Authentication and MCP boundaries:** reran issuer, audience, owner subject/email, expiry, alternate host, callback-like route, body limit, raw signature and actual MCP HTTP dispatch tests. No bypass was found in those exercised cases.
- **Cancellation honesty:** reran pending cancellation, unknown-identity cancellation and unconfirmed-termination tests. A successful provider update alone does not produce confirmed termination.
- **Provider identity:** inspected call/account/from/to checks and conversation correlation before applying results. Replayed callback payloads are not directly trusted as result content.
- **Schemas against primary provider documentation:** checked dispatch fields, conversation identity/status/cost fields, Twilio phone import, webhook configuration and model fallback definitions against the public ElevenLabs API schema. No API-shape defect is claimed from this review; no live response was available to prove compatibility.
- **Unknown costs and funding:** missing prices, expired quotes and insufficient credits fail closed in the existing tests. Fixed costs and extra allowances require explicit operator values. No top-up or billing upgrade code exists.
- **Time:** task acceptance, deadlines and retention use explicit millisecond values; provider start time is read from provider data; accounting months use UTC ISO strings. No file timestamp was used as logical time.
- **Retention purge and ancient retries:** reran purge tests for both terminal and unresolved calls. Purge retains hashes and aggregate accounting without private task content. The pre-purge duplicate branch remains the separate defect above.
- **Provisioning blast radius:** inspected the exact-plan review hash, write-before-mutation journal and stop-on-uncertain-result behavior. Creation is scoped to new resources. The deployment wrapper checks reviewed build/secrets/config hashes, selected account, exact hostname, and disabled alternative URLs. These are local controls, not proof of successful cloud provisioning.
- **Model permissions and evaluation honesty:** the declared agent has four phone controls, no transfer tool, no MCP servers, no knowledge base and no cross-call history. GPT-4.1 Mini and disabled conversational fallback are configured; actual served identity and behavior are unobserved. Prepared conversational cases and real acceptance remain correctly marked not run.
- **Caps and retry amplification:** examined field lengths, 64 KiB MCP bodies, 2 MiB webhook bodies, 100-row/turn pages, 100-conversation lookup with explicit ambiguity rejection, one active call, 15-second provider requests, 15-second active polling, 60-second initial terminal polling, hourly terminal polling after one day and 30-day expiry. They are documented. The sequential scheduler amplification is finding 5.
- **Secrets and collateral:** inspected public templates, ignore rules and public source; no real credential was found in the reviewed artifact. Private files were deliberately outside review scope.

The verdict applies to handing off the local implementation as complete. It does not require account access to resolve these findings and does not authorize provisioning, deployment, client registration or paid evaluation.
