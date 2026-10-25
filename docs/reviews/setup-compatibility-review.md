# Setup compatibility review

Verdict: **ship**. Counts: blocker 0, must-fix 0, should-fix 0, nit 0.

This fresh adversarial review covers the account-inspection response compatibility change, the Twilio phone-number pricing URL correction, and the corresponding setup status in `README.md` and `docs/EVALUATION.md`. It does not authorize provisioning, deployment, or a paid call. Those actions still require their own concrete execution review.

Request: `docs/REQUEST.md`, especially account identity inspection, current rates before spending, and reporting attempted, succeeded, and failed checks. The review assignment limits this pass to the two scripts compared with `private/setup-compatibility-before/`. The working directory has no Git repository metadata, so the reviewed artifacts are identified by complete SHA-256 hashes instead of a commit range.

## Artifact identity

| File | SHA-256 |
| --- | --- |
| `scripts/account-inspect.ts` | `09a2040c9a3107c28995a03acadfbd4cf6b6c0be6a6d70bcc00ef9fb296f927d` |
| `scripts/provision.ts` | `05af2a3650a3837ae56cc7df9010bb5359109b1ff651d5a1e6c3a9a0baebc3cf` |
| `README.md` | `430dfed6b34612f5013f39efdc4fbc7790380abf6134b0adca020f37b7cf9a65` |
| `docs/EVALUATION.md` | `cc2f6bd5e006b356ca4fa8737177e72d467c809da65ca1684cbd0670e081b276` |
| `private/setup-compatibility-before/account-inspect.ts` | `0117f69b7a0b7dd1d3145592788c925c36004ebc64066fbb7a6910ddf231a69a` |
| `private/setup-compatibility-before/provision.ts` | `bfa9b7c1b24c6671c0d1a3d76bed006f6d55a02e3870f48967596779f5d8a46f` |
| `private/inspect-fixture-loader.mjs` | `7757aea808fbe641d16f18314a00fc9187361e7dc9fbc2d1362b14c7be77861b` |
| `private/setup-fixtures-sanitized.json` | `35b214fd1af4dbfd0558646ba39b29665a9f04c605832b49fbeed231c30d86fa` |
| `private/account-evidence/twilio-number-prices.json` | `a15fe24e122992bc6011c536f94bc7142ac69725504e47a86381e518017c370b` |
| `private/account-evidence/twilio-number-prices-source-check.json` | `8dde28003fa0ebd59751ffb4c0d7186d506ed701b15db93f6d5cb40592c77548` |

Hashes were obtained with `shasum -a 256` over the exact paths above. No source edits were made by this reviewer.

## Findings

None within this scoped change.

## Reproduced evidence

All commands ran from `/Users/tonygwu/Code/phone-calls/repo-0`. The fixture loader was read in full before use. It substitutes synthetic credentials and identities, blocks unexpected fetch URLs, and changes to a fresh temporary directory before scripts write evidence. The complete sanitized response fixture and both non-secret pricing responses were read before trusting their parsed fields. The reviewer did not read `.dev.vars`, the raw Twilio account response, or login storage, and made no live provider requests or mutations.

The original script fails on the captured response shape:

```sh
node --import tsx --import ./private/inspect-fixture-loader.mjs private/setup-compatibility-before/account-inspect.ts
```

Observed exit code: `1`.

```text
ZodError: [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": ["email"],
    "message": "Invalid input: expected string, received undefined"
  }
]
```

The updated script accepts that same fixture:

```sh
node --import tsx --import ./private/inspect-fixture-loader.mjs scripts/account-inspect.ts
```

Observed exit code: `0`.

```text
{
  provider: 'ElevenLabs',
  user_id: 'user_example',
  workspace_id: 'workspace_example',
  first_name: 'Example'
}
{ attempted: 4, succeeded: 4, failed: 0, failure_category: null }
```

Required identity is still enforced:

```sh
INSPECT_MISSING_IDENTITY=1 node --import tsx --import ./private/inspect-fixture-loader.mjs scripts/account-inspect.ts
```

Observed exit code: `1`.

```text
{
  provider_check: 2,
  error: 'Account response failed identity/schema validation; inspect the private raw evidence.',
  failure_category: 'account_response'
}
{
  attempted: 4,
  succeeded: 3,
  failed: 1,
  failure_category: 'account_read_or_response'
}
```

An additional inline Python harness launched the updated script seven times through the same offline loader. A fetch wrapper independently injected an empty user ID, empty workspace ID, empty first name, wrong Twilio account SID, wrong Twilio balance account SID, HTTP 401, and malformed JSON. Each child process exited `1`, reported `attempted: 4`, `succeeded: 3`, and `failed: 1`, and retained a concrete error on stderr. The harness asserted those conditions and printed:

```text
Adversarial account cases: attempted 7, succeeded 7, failed 0
```

The pricing correction was checked against [Twilio's official phone-number pricing reference](https://www.twilio.com/docs/phone-numbers/pricing). It documents the `v1` base path and the exact US resource now used by the script. The complete saved old response reports provider code `20404`, HTTP status `404`, and the missing `/v2/PhoneNumbers/Countries/US` resource. The complete saved corrected response identifies US, USD, and the same `v1` URL as the source, with a local monthly price of `1.15`.

An inline Node assertion extracted the rental URL from both script versions, required exactly one match per version, checked the saved old response's error identity, compared the new URL with the returned URL, and applied the source's country, currency, and price schema to the corrected response. It exited `0` and printed:

```text
{
  attempted: 1,
  succeeded: 1,
  failed: 0,
  source_url: 'https://pricing.twilio.com/v1/PhoneNumbers/Countries/US',
  served_url: 'https://pricing.twilio.com/v1/PhoneNumbers/Countries/US',
  iso_country: 'US',
  price_unit: 'USD',
  local_monthly: '1.15'
}
```

The local validation was independently rerun:

```sh
npm run check
```

Observed exit code: `0`. TypeScript completed without diagnostics. The test and build output was:

```text
✓ test/providers.test.ts (10 tests)
✓ test/mcp.test.ts (1 test)
✓ test/engine.test.ts (34 tests)
✓ test/security.test.ts (6 tests)
Test Files  4 passed (4)
     Tests  51 passed (51)
✓ 265 modules transformed.
◆ Build complete
```

These are simulated tests and saved-response checks. They provide no new evidence of live deployment or voicemail delivery.

## Attacked and held

- Scope fidelity: response identity compatibility maps to `scripts/account-inspect.ts:33`; error accounting maps to lines 24–45; the rate lookup correction maps to `scripts/provision.ts:70`. The remaining source lines in both snapshot comparisons are unchanged. The two status documents retain pending provisioning, deployment, and real voicemail acceptance.
- Tests that can fail: executing the preserved original account script on the same fixture reproduced the missing-email failure; the updated script passed. Removing required identity and seven independent malformed-response mutations still failed.
- Silent fallbacks: the added catch increments the failed count, reports an explicit schema category, preserves the raw response through the existing inspection function, and leads to a nonzero process exit. No success default was introduced.
- Buried decisions: user ID, workspace ID, and first name are explicitly required to be nonempty. No cap, timeout, sample, retry, or truncation changed. The script continues to report the returned ElevenLabs identity for human inspection rather than claiming comparison with a configured expected ElevenLabs identity.
- Edges and state: empty identity fields, mismatched Twilio identities, HTTP failure, and malformed JSON cannot yield successful totals. Failure of one check does not suppress reporting for the remaining successful checks.
- Time: no timestamp, filesystem time, expiry rule, or time-zone behavior changed.
- Documentation and sibling sweep: searched the scripts, source, README, and docs for both pricing paths and the changed identity fields. No remaining implementation use of the `v2` phone-number pricing endpoint or ElevenLabs account email requirement was found. Runtime call correlation uses of `user_id` serve a different purpose and are unchanged.
- Collateral: inspected the full source diffs, sanitized fixture, and fixture loader. No credential or private destination was introduced by the change. Existing credential and login status claims were outside this credential-excluding review and were not re-audited.
- Blast radius: the pricing URL changes only the read before existing provisioning mutations. Paid-account, exact country/currency, and reviewed-price gates remain unchanged. Neither provisioning mode nor deployment was executed during this review.
- Progress honesty: success reports four attempted checks, four succeeded, and zero failed. Every injected failure reports four attempted, three succeeded, and one failed, with an error category and nonzero exit.

## Verdict

**ship** for the artifact hashes above. Counts: blocker 0, must-fix 0, should-fix 0, nit 0. The compatibility changes are ready to be included in a separately reviewed provisioning plan.
