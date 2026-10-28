# Calling reliability audit, October 28, 2026

The configuration gate caused the latest outage before any dial request. ElevenLabs added two response defaults: an empty speech-recognition keyterm list and a widget transcript-display setting. That changed the saved configuration fingerprint while the provider's agent-update timestamp stayed unchanged. The service returned `CONFIG_DRIFT`. Normalizing individual defaults repaired the immediate incident but left future additions able to cause another outage.

The owner explicitly directed complete gate deletion and, in the parallel repo-0 chat, removal of readiness, duplicate-call and spending controls. Commit `007f9b0` implemented and deployed that broader simplification. This audit's earlier, narrower draft was preserved privately and superseded. It was not deployed over the newer database. There is no agent configuration inspection, fingerprint, required-setting comparison or replacement version pin. The owner edits the agent in ElevenLabs directly. The four tools start, get, list and cancel calls; every start creates a separate task.

The review covered all ten runtime modules, four operational scripts, configuration, tests and current documentation. Three independent roles examined evidence, lifecycle/concurrency, and provider/operational behavior. The upstream simplification was then read and the surviving fixes adapted to it. No audit probe placed a call or ran a paid conversation simulation.

| Finding | Final disposition |
| --- | --- |
| Provider response changes blocked all calls | Entire configuration gate deleted upstream. Start uses only the outbound provider POST. |
| Readiness, expiry, budget and unknown-dispatch locks could block later requests | Removed by the owner's broader simplification, including obsolete SQLite admission tables. No replacement checks added. |
| Explicit authentication refusal was labeled an uncertain dispatch indefinitely | HTTP 401/403 now records `not_dispatched` and an actionable error. Contradictory callback identity evidence takes precedence in either arrival order. Timeouts and other uncertain errors do not trigger automatic redial. |
| A valid tool-only transcript turn rejected the whole conversation | Accept the documented omitted message and return null text. Transcript, outcome and cost evidence survive; malformed non-string text is still rejected. |
| Existing tests missed the real durable HTTP adapter | Added real start/get/cancel/list/callback and alarm tests with synthetic provider responses. An unconditional HTTP 503 mutation previously survived all 77 original tests; the new route test fails under that mutation. |
| Local preflight accepted invalid config and failed CLI login | Validate existing configuration with field diagnostics and require successful CLI authentication. This operator maintenance command is separate from calling. |
| Synthetic outbound fixture matched dispatch by path alone | Require the expected provider hostname and credentials; unrelated hosts fail. |

The surviving provider/engine regression command is `node_modules/.bin/vitest run test/engine.test.ts -t 'reliability regressions|late callback'`. Before fixes it failed four expectations; afterward all nine passed. These cover HTTP rejection classes, callbacks in both arrival orders, optional transcript text and malformed text. Operational tests use temporary synthetic directories. Full checks use `npm run check`, including typecheck, Worker tests, operational tests and build. Raw evidence and the independent review reports remain in ignored `private/reliability-audit/`.

Remaining limits: providers can still reject invalid credentials, unavailable funds or incompatible owner-edited agent settings. Carrier and hosted-service outages can prevent calls. An uncertain task may remain unresolved if no provider identity ever appears, but it no longer blocks another call or creates a retained lock. Starting again creates another call and can duplicate an earlier uncertain request. The service itself never automatically retries the outbound POST.

No readiness or unit-test result proves successful speech, voicemail receipt, keypad behavior or business outcomes. Existing live-call evidence is historical. The production verification for this release checks exact deployment identity, preserved history, authentication and signed HTTP boundaries without contacting a recipient. Full live speech after these changes remains untested.
