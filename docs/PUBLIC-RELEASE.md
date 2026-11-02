# Public-release review

Reviewed on November 2, 2026, against source commit `0a3c2b3` and the documentation changes accompanying this report.
The review did not deploy, provision resources, update the live agent, place calls, or change repository visibility.

The project is a credible early release for operators who can configure Cloudflare and the telephone providers.
It is not a turnkey installation where two API keys immediately produce a ChatGPT plugin.
Publication still needs the planned history cleanup after other writers finish. The owner permits the existing institutional commit email.

## Tests: strong runtime coverage, with specific gaps

The required gate was `npm run check`. Its load-bearing output was:

```text
Test Files  11 passed (11)
     Tests  152 passed (152)
ℹ tests 62
ℹ pass 62
ℹ fail 0
✓ 267 modules transformed.
◆  Build complete
```

The 214 tests include real SQLite Durable Objects, alarms, HTTP MCP transport, signed conference routes, and isolated operational commands.
They cover uncertain dispatch, callbacks racing with dispatch, stale observations, cancellation, deadlines, restarts, retention, and provider identity mismatches.
The conference tests also cover owner acceptance, voicemail detection, capped invitations, and cleanup of separate telephone legs.
These assertions test observable behavior; they do more than mirror implementation details.

An ad hoc coverage run used `@vitest/coverage-istanbul@4.1.12`, installed without saving dependencies or changing the lockfile.
The command was:

```sh
node_modules/.bin/vitest run --coverage --coverage.provider=istanbul \
  '--coverage.include=src/**/*.ts' --coverage.reporter=text \
  --coverage.reporter=json-summary --coverage.reporter=json \
  --coverage.reportsDirectory=coverage/public-review
```

Its complete source inventory contained all 12 runtime modules. The summary was:

```text
Statements   : 87.1% (878/1008)
Branches     : 83.08% (712/857)
Functions    : 93.61% (132/141)
Lines        : 93.34% (673/721)
```

| Runtime area | Lines | Branches |
| --- | ---: | ---: |
| Call engine | 97.87% | 87.56% |
| Conference controller | 98.52% | 90.74% |
| SQLite storage | 100% | 91.66% |
| Public HTTP entry point | 63.15% | 56.52% |

These percentages cover `src/`, not the Node operational scripts.
The standard gate has no coverage thresholds or saved coverage dependency.
To reproduce this optional measurement, install the matching instrumentation first:

```sh
npm install --no-save --package-lock=false --ignore-scripts @vitest/coverage-istanbul@4.1.12
```

Run `npm ci` afterward to restore the exact locked dependency tree.
[Cloudflare documents Istanbul instrumentation](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#coverage) for its test integration.

The review removed the owner identity check in a disposable copy. The existing owner-authentication test failed as expected.
Removing the durable dispatch marker exposed a test weakness: an assertion inside the mocked provider was caught as a provider error.
The original dispatch test still passed. This change moves that assertion outside the provider callback and checks the final saved status and error.
The strengthened test rejects the missing marker with `expected 'pending' to be 'dispatching'`.
Restoring the marker returns the test to passing. No runtime implementation changed.
This is a targeted test-quality check, not a complete mutation-testing score.

The remaining test work is concrete:

- Exercise successful owner authentication through the complete Worker-to-MCP-to-ledger path, rather than separate component checks.
- Cover authenticated recording access, cross-origin rejection, and malformed HTTP inputs at the public entry point.
- Add isolated tests for `scripts/provision.ts` and `scripts/deploy.mjs`, including review hashes, account mismatch, and uncertain creation.
- Add CI for `npm ci` and `npm run check`. No workflow currently runs these checks on pushes or pull requests.
- Confirm a fresh operator can complete installation in separate accounts. This review did not purchase resources for that experiment.

Synthetic tests do not establish acoustic quality, voicemail timing, live OAuth compatibility, or a business outcome.
Historical simulations test particular prompts and fixtures; they are not a measured reliability rate for the current service.

## Privacy: no detected credentials, but history still exposes personal details

Gitleaks 8.30.1 was downloaded from its official release and checked against the published SHA-256 checksum.
The full reachable-history command was:

```sh
gitleaks git --redact --no-banner --log-opts=--all .
```

Its output was:

```text
18 commits scanned.
scanned ~1458407 bytes (1.46 MB)
no leaks found
```

Git contains 20 reachable commits, including two merge commits.
A separate content audit inspected all 185 original tracked paths and every reachable blob among the 460 Git objects present at that inspection.
Local Codex capture and checkpoint references add snapshot objects over time, so a later `--all` object count can increase without new commits.
It searched for credential forms, non-example phone numbers, email addresses, local home paths, personal hostnames, and the named contact in the supplied screenshot.
It used no file sampling or truncation. The apparent secret assignments were synthetic test fixtures.
No real credential or non-example personal telephone number was found in that text audit.
Scanner results are evidence about these patterns, rather than a guarantee that no sensitive material exists.

The current documentation contained local checkout paths and a personal service hostname in 34 files.
This change replaces them with explicit placeholders or `calls.example.com` and redacts two historical agent-version references.
The client guide also removes installation notes about individual profiles and a dependency on the author's separate skills checkout.
Historical operational records remain labeled as historical.

Both README images contain only decoded pixels, with no EXIF or XMP metadata.
The result image crops away the phone number, family and calendar notes, contact reference, and recording URL.
Three opaque boxes cover the restaurant name, reservation holder, and reservation date.
Pixels outside those boxes match the source crop exactly. The progress screenshot preserves all visible source pixels.
The AI-generated edit was rejected because it changed terminal lettering; it is not included in the repository.

**Pending publication step:** earlier commits still contain the redacted local paths and hostname.
Commit author and committer metadata also contains the author's name and institutional email address.
The owner explicitly permits `tonywu@cs.stanford.edu` in commit history. Do not rewrite that address solely for privacy.
The remaining identifiers are not credentials, but publishing this repository publishes its history too.
The license intentionally credits the author, and the public GitHub repository URL identifies its owner.

The owner selected sanitization within the existing repository, with as much original history and merge structure as possible.
A new public repository from a snapshot is not the selected approach.
The ordered release plan below records the coordination and verification requirements. No history rewrite or force-push is authorized now.

## Installation: configurable for one owner, with manual prerequisites

Private configuration supplies the hostname, Access issuer and audience, owner email and subject, phone numbers, provider IDs, and voice.
The runtime does not contain a personal phone number, account credential, or production hostname.
This is a useful base for independent installations, but it has deliberate product boundaries:

- Each installation serves one owner. It is not a shared service where each visitor enters provider keys.
- Calls support valid US destinations only. Other `+1` destinations are excluded.
- A Cloudflare account, managed domain, Access application and owner identity are required in addition to provider credentials.
- Setup provisions an ElevenLabs agent, webhook, number import, Access policies, and a purchased Twilio number.
- Models are source defaults in `src/agent.ts`, rather than configuration fields in `examples/setup.json`.
- The Worker name is fixed in the Cloudflare configuration, Durable Object binding, and deployment validation.
- OAuth needs an installation-specific remote callback URI. The example URI is not universal.
- Local development needs complete runtime configuration; `.dev.vars.example` alone does not configure a working server.
- Owner conferences currently need four simultaneous Twilio calls. An account limited to three cannot complete owner joining.

The README now states these requirements and links the complete deployment process.
The client guide follows [OpenAI's connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt) and [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).
Client availability depends on account and workspace policy.
The review verified local build and test behavior, not a complete new-account deployment or new ChatGPT connection.

For a turnkey claim, the next work is a tested first-installation flow with explicit credential scopes and owner-identity discovery.
It also needs isolated provisioning/deployment tests, clearer recovery steps, and a decision about which model and Worker fields become configuration.

## Other release considerations

The owner selected MIT. This change adds `LICENSE` and matching package metadata, plus contribution and security-reporting guidance.
The lockfile dependency audit command was `npm audit --json`; its vulnerability totals were:

```json
{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
```

That result is a point-in-time advisory check, not a complete dependency security review.
The Cloudflare CLI and Vite plugin use prerelease versions. The current locked build passes, but upgrades need another full check.
The global Node 24.20.0 installation emitted an engine warning during installation; npm scripts used the pinned Node 24.22.0 runtime.
The README now names Node 24.22.0 explicitly.

GitHub reported the repository as private, unarchived, and without a license before these changes.
Its API returned `security_and_analysis: null`; that does not establish which security features are enabled.
Repository settings, branch protection, private vulnerability reporting, and Actions permissions still need an owner inspection before publication.
No new CI workflow or scheduled work was installed during this review.
The package retains `private: true` to prevent accidental npm publication. That field does not control GitHub repository visibility.

There is no application spending ceiling, duplicate-request protection, or ordinary-call concurrency limit.
Requested call duration has no application-level maximum. These are existing design choices, now stated prominently in the README.
Public users need to understand them before connecting an assistant to an account that can spend money.

Cloudflare observability is disabled. Operators currently rely on stored task errors and provider state for diagnosis.
Sanitized operational logging would improve support, but request bodies, tokens, transcripts, and recording URLs must stay out of logs.
This review did not change logging or the existing call-admission design.

## Recommended publication decision

Release as an early, self-hosted, single-owner project after the approved historical-privacy cleanup.
Describe manual setup and the test gaps directly. Avoid advertising installation with API keys alone or a guaranteed calling success rate.
Before a broader turnkey release, add CI, provisioning/deployment tests, and an independently completed installation walkthrough.

## Release plan and owner decisions

The owner supplied these decisions on November 2, 2026. They supersede the earlier snapshot alternative.
The reference baseline is `0a3c2b35111c47110e24370bbe74a54ee8e4cb86`; it is not a reset target.
Preserve newer completed work and incorporate it before preparing the history rewrite.

| Item | Status at this review | Required next evidence |
| --- | --- | --- |
| Review, documentation, images, and license | Succeeded; fresh full and scoped reviews returned `ship` with zero findings | Repeat affected checks if later work changes the reviewed behavior |
| Incorporate the other writer's completed work | Attempted; completed documentation commit `6523f14` is incorporated | Obtain a later completion acknowledgement and incorporate remaining finished work |
| Sanitize the existing repository's history | Blocked on unfinished writer coordination and a reviewed execution plan | All writers idle, completed work incorporated, exact refs recorded, and required approvals |

The owner reports that the phone-11 Codex agent has work in progress.
A coordination request asks that writer to confirm its latest completed commit and any unfinished writes.
The request is queued; receipt and final completion are not yet established.
A clean checkout or a completed earlier turn does not satisfy this barrier.

Apply the following order:

1. Finish the review and documentation work. Preserve and incorporate newer completed commits through normal Git coordination.
2. Wait for phone-11 to finish its authorized work and identify its final completed commits.
3. Coordinate every other writer, incorporate completed work, and establish a shared pause on writes for the rewrite window.
4. Complete the remaining chosen release preparation. The history rewrite must be the very last preparation step.
5. Prepare a concrete, reviewed replacement plan and a private backup of the original repository and refs.
6. Immediately before the eventual rewrite, save the exact inventory below, plus branch and tag targets.
7. Rehearse the rewrite in an isolated copy. Retain commits and merges, including commits that sanitization makes empty.
8. Use the rewrite's old-to-new commit map to compare every original commit with its rewritten counterpart.
9. Run fresh source, secret, and privacy checks on the rewritten result, then obtain the required review and approval before replacing shared history.
10. After an approved replacement, verify remote refs and coordinate existing clones before any writer resumes.

The required original inventory command is:

```sh
git log --all --format='%H %P %aI %cI'
```

Save its output as private evidence with the exact ref inventory. Do not derive dates from file modification times or local date formatting.
Compare the original and rewritten records through the commit map, rather than comparing commit IDs directly.
Every original commit must have an accounted-for result. Its ordered parent list must map to the rewritten parent list.
Original author and committer dates, times, and timezone offsets must match exactly, including distinct author and committer timestamps.
Do not normalize offsets or redate commits. Preserve the original merge structure and approved commit email.
Any dropped commit, collapsed merge, unexpected ancestry change, or timestamp change requires an explicit disposition before replacement.
The final incorporated commits from phone-11 must remain reachable through their mapped counterparts.

This is a preparation plan, not permission to run the rewrite, force-push, reset another checkout, or make GitHub public.
No rewrite or force-push occurred during this review. Those actions remain subject to writer coordination and the repository's review and approval requirements.
