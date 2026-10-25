# Destination pricing compatibility review

Verdict: **ship** for the destination pricing fix. Findings: blocker 0, must-fix 0, should-fix 0, nit 0. This review does not approve provisioning, deployment configuration, a paid call, or the separate ElevenLabs agent creation change.

The request is recorded in `docs/REQUEST.md`. The relevant requirements are “Check current rates, credits, and remaining budget before dialing” and “Surface unknown costs and funding requirements before spending.” This fresh review covers `src/providers.ts`, `test/providers.test.ts`, and the destination pricing policy in `docs/OPERATIONS.md`. The source and test diffs were reconstructed against `private/pricing-before/`. This directory has no Git history to identify a commit range.

## Artifact identity

Command: `shasum -a 256 src/providers.ts test/providers.test.ts docs/OPERATIONS.md private/pricing-before/providers.ts private/pricing-before/providers.test.ts private/account-evidence/twilio-self-destination-pricing.json private/account-evidence/twilio-filtered-destination-pricing.json`

```text
403d049a1ff1b797da6ade5aec28bd519cab79d03bbdd1a549b24b4af5075a2d  src/providers.ts
6e47db7cf4f756c778d6913d11c8eface6755f6c9a776781ae0e40220a12cfa7  test/providers.test.ts
f5ebbd98ad61655958fd7fc841d2aa68c449ac13fb99e44a295771bf149eb965  docs/OPERATIONS.md
370b232470cb05ef6a1ad97aa2b58ea88e7694cb635e9159415a888b5fe7a771  private/pricing-before/providers.ts
4cf5b5119bc3494c9d4e06c4407bc2a83874814f72cd6dbd8cc652b9110aab33  private/pricing-before/providers.test.ts
67119dda3714bd4ccd022de8e29cc8654796b7f795d4144c5be0a25343a423ad  private/account-evidence/twilio-self-destination-pricing.json
d6e02855be21122a09565b90777a122acf295093f2f8f203424dd9d50ec6027b  private/account-evidence/twilio-filtered-destination-pricing.json
```

## Findings

None in the scoped change.

## Verification

The reviewer independently ran `PHONE_CALLS_HOSTNAME=calls.example.com npm run check`. The first attempt passed type checking but could not start the test workers because the sandbox denied a localhost listener. It ran zero tests and reported four infrastructure errors: `listen EPERM: operation not permitted 127.0.0.1`. The approved retry outside the sandbox completed with exit 0:

```text
> tsc --noEmit
Test Files  4 passed (4)
     Tests  60 passed (60)
✓ 265 modules transformed.
◆  Build complete
```

That is 60 attempted, 60 succeeded, 0 failed. The configured deployment hostname was preserved. No deployment command ran.

To test whether the tests can fail, the reviewer copied only source, tests, package metadata, and test configuration to `/private/tmp/destination-price-review-n2y0go51`. The shared workspace source was never replaced. The isolated provider checks used `npm test -- --config review.vitest.config.ts`, with a Node test environment and the same provider implementation and fixtures.

- Original implementation with current tests: 19 attempted, 16 succeeded, 3 failed. The successful preflight failed with `PROVIDER_SCHEMA`; both route rejection tests received that schema error before reaching `ROUTING_UNSAFE`. Raw output: `docs/evidence/destination-price-review-baseline.txt`.
- Current implementation: 19 attempted, 19 succeeded, 0 failed. Raw output: `docs/evidence/destination-price-review-green.txt`.
- Eight separate deliberate breakages: 152 tests attempted, 144 succeeded, 8 failed as intended. Removing the caller query, destination equality, or caller equality each failed the corresponding test. Allowing absent caller identity, multiple prices, an invented zero for a missing price, a negative price, or absent prefixes each failed the corresponding rejection test. Exact results and raw log names are in `docs/evidence/destination-price-review-mutations.json`.
- Additional reviewer probes: 40 attempted, 40 succeeded, 0 failed, including the existing 19 provider tests and 21 additional cases. Nineteen cases verified exact error categories for malformed decimals, numeric/null prices, overflow, negative rates, wrong currency/country, null or mismatched identities, null/empty/duplicate price arrays, and empty or wrongly typed prefix metadata. Two cases verified exact quote arithmetic for a zero rate and a changed positive rate. The malformed cases also asserted that preflight issued only GET requests. Output: `Tests  40 passed (40)`. The reproducible probe source is saved in `docs/evidence/destination-price-review-probes.test.ts.txt`.

## Attacked and held

- Scope: the current rate requirement maps to the filtered request and array schema at `src/providers.ts:77`; exact destination/caller identity maps to line 97; unknown or invalid cost rejection maps to lines 81 and 98; tests and the operations paragraph document those changes. No unrelated runtime edit appeared in the reconstructed diff.
- Provider contract: read both complete raw private response bodies before relying on their schema. The unfiltered response has a null origin; the filtered response has both numbers and one USD rate of `0.014`. These fields agree with the currently published [Twilio Voice Pricing documentation](https://www.twilio.com/docs/voice/pricing), including its `OriginationNumber` query and `outbound_call_prices` response array. Private phone numbers were not copied into this report or new fixtures.
- Identity: removed each exact-number assertion independently and observed its test fail. The request uses the configured account SID in Basic authentication, and existing account, incoming-number, and balance identity checks remain intact. The pricing response itself contains no account SID, so its body alone does not independently attest to the served account. This review did not inspect credentials or make another live provider request.
- Missing and ambiguous data: empty or multiple price records fail before admission. Duplicate equal prices also fail. Missing caller, missing price, and missing prefix metadata cannot become a guessed value. Malformed price failures retain `PROVIDER_SCHEMA`, invalid numeric rates retain `PRICING_UNKNOWN`, and mismatched numbers retain `IDENTITY_MISMATCH`.
- Hidden policy choices: exactly one price is an intentional availability restriction on every destination after caller filtering. Even equal duplicate rates are rejected. Prefix strings and arrays must be nonempty. No cheapest-rate selection, prefix-selection heuristic, fallback, sampling, or truncation was introduced. The operations document states the one-price policy.
- Numerical behavior: strict decimal parsing rejects whitespace and partial numeric strings. Finite nonnegative rates reach the existing quote arithmetic; positive-rate changes alter the reservation, and a genuine zero remains valid. The existing funding and monthly-budget checks remain in place.
- Tests and regressions: reproduced the original failure, caught eight deliberate breakages, and completed the full Cloudflare test suite and build. Existing route failures are no longer masked by the outdated price schema.
- Documentation and sibling patterns: searched `src`, `test`, `docs`, `scripts`, and README for the changed pricing identifiers. No active singular `outbound_call_price` consumer remains. The operations policy matches the implementation.
- Time: the fix adds no wall-clock, file-time, expiry, or month calculation. Probe time comes from the existing explicit UTC fixture.
- Blast radius: the changed provider request remains a GET. Review activity used synthetic provider requests, local test copies, and an official documentation read. No live calls, provider mutations, deployment, or credential reads were performed.

## Verdict

**ship**. No findings above nit. Counts: blocker 0, must-fix 0, should-fix 0, nit 0. The verdict applies only to the artifact hashes above.
