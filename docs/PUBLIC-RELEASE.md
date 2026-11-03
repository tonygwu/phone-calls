# Public-release review

Reviewed on November 2, 2026, against source commit `0a3c2b3` and the documentation changes accompanying this report.
The review did not deploy, provision resources, update the live agent, place calls, or change repository visibility.

The project is a credible early release for operators who can configure Cloudflare and the telephone providers.
It is not a turnkey installation where two API keys immediately produce a ChatGPT plugin.
Publication still needs the planned history cleanup and feature integration. The owner permits the existing institutional commit email.

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

The two Claude Code README images contain only decoded pixels, with no EXIF or XMP metadata.
The result image crops away the phone number, family and calendar notes, contact reference, and recording URL.
Three opaque boxes cover the restaurant name, reservation holder, and reservation date.
Pixels outside those boxes match the source crop exactly. The progress screenshot preserves all visible source pixels.
The AI-generated edit was rejected because it changed terminal lettering; it is not included in the repository.

The ChatGPT example uses deterministic pixel editing and preserves the full supplied screenshot, including the ChatGPT interface.
Opaque black boxes cover the contact's name, the personal CRM title and icon, account initials, and every phone digit except the last two.
The exported image contains no source metadata. Pixels outside the boxes match the source exactly.
The README identifies the CRM as a separate connector, and the screenshot preserves the uncertainty about voicemail delivery.

**Pending publication step:** earlier commits still contain the redacted local paths and hostname.
Commit author and committer metadata also contains the author's name and institutional email address.
The owner explicitly permits `tonywu@cs.stanford.edu` in commit history. Do not rewrite that address solely for privacy.
The remaining identifiers are not credentials, but publishing this repository publishes its history too.
The license intentionally credits the author, and the public GitHub repository URL identifies its owner.

The owner selected sanitization within the existing repository, with as much original history and merge structure as possible.
A new public repository from a snapshot is not the selected approach.
The ordered release plan below permits a reviewed local rewrite in isolation. Replacing shared history remains a separate, held action.

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

### Follow-up: guided Cloudflare setup

The owner chose to retain Cloudflare-specific hosting and defer a shared hosted service.
The README now walks a new operator through accounts, Access sign-in, credentials, configuration, reviews, provisioning, deployment, client login, and a separately authorized first call.
`npm run setup` supplies a local configuration wizard and reads the owner ID from the selected Access account.
It also provides local validation, protected templates, deployment-plan hashes, and exact-hash review recording.
These commands never purchase a number, upload a Worker, or place a call.
The existing external-action gates remain in `provision:apply` and `deploy`.

The example no longer guesses a ChatGPT callback. Its remote list starts empty; the operator adds the exact client callback later.
The setup/provision contract permits that empty list while retaining the separate localhost/loopback registration settings.
New isolated tests exercise the helper, its CLI owner lookup, provisioning preparation, stale review hashes, and configuration mismatch refusals.
This addresses local onboarding gaps, not the remaining need to complete a fresh installation in independently owned provider accounts.

The follow-up's fresh `npm run check` reported `152 passed (152)` Worker tests, `pass 82`, `fail 0`, and `Build complete`.
The local walkthrough rehearsal prepared deployment hashes with `approved: false`, `deployed: false`, and `calls_placed: 0`.
A fresh adversarial review returned `ship-with-notes` with zero blockers, zero must-fix findings, and one documentation note.
The callback-update review requirement was then made explicit in the README and deployment guide, resolving that note.

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

The owner revised this order on November 2, 2026. These decisions supersede the earlier wait-before-rehearsal instruction and snapshot alternative.
The reference main is `55dc850ccbba8c5fcaa7fd8cb9d3381eb520a046`. It is not a reset target; preserve all newer work.
The guided setup follow-up is `e3ebc3138d2a46069d89edcd500df05d9bf17b17`.
The existing repository will be sanitized. A new public repository from a snapshot is not the selected approach.

| Item | Status at this update | Required next evidence |
| --- | --- | --- |
| Review, documentation, images, and license | Succeeded; earlier full and scoped reviews cleared the respective changes | Review new changes and repeat affected checks |
| Coordinate the other writer's feature work | Attempted; the earlier documentation commit is incorporated | Exact feature branch, branch point, final completed tip, and any required merge commits |
| Prepare a local sanitized candidate | Authorized in a separate disposable clone; execution awaits a fresh review of the concrete plan | Private backup, original inventories, reviewed transformation and verification commands |
| Replace shared history and make GitHub public | Held; neither action is authorized | Completed feature integration, paused writers, fresh final review, and owner approval |

The owner permits local preparation and execution while phone-11 continues developing on a feature branch.
A clean checkout or receipt of a coordination message does not prove that the feature is complete.
Record its exact branch point and final tip before integrating it. Preserve the complete required feature history, including merges.
Do not interrupt, reset, or delete another writer's work.

Apply the following order:

1. Fetch origin and inspect the reference commit. Preserve newer work and complete ordinary review and documentation changes through normal Git coordination.
2. Prepare a concrete local rewrite plan and obtain a fresh adversarial review before executing it.
3. Use a separate disposable clone. Preserve original refs and objects in a private backup, then save the inventory below before rewriting.
4. Sanitize the local candidate while feature development continues. Keep rewritten main local and disable accidental pushing from the disposable clone.
5. Obtain phone-11's exact branch point and final completed tip. Back up its original objects and metadata before replaying required feature commits onto rewritten main.
6. Preserve original author and committer metadata explicitly. Reconstruct each merge with its mapped, ordered parents instead of flattening it. Resolve integration conflicts without undoing sanitization.
7. Verify the combined history, current source, secrets, and private-content checks. Run `npm run check`; require exit zero, zero failed tests, and `Build complete`.
8. Review the exact final candidate. Record its tip, old-to-new commit map, verifier counts, and every exception under ignored `private/public-release/`.
9. Coordinate and pause all writers. Back up uncommitted work, unpushed commits, ignored private configuration, and local checkout settings before planning fresh clones.
10. Obtain owner approval for the exact shared-ref replacement. Replacing shared history remains the very last release-preparation step. Verify remote refs afterward and establish fresh clones before writers resume.

The required original inventory command is:

```sh
git log --all --format='%H %P %aI %cI'
```

Save its output with the exact ref inventory and original raw commit objects as private evidence.
Record machine-local non-commit references separately; they belong in the private backup, not the public candidate.
Do not derive dates from file modification times or local date formatting.
Compare original and rewritten records through the commit map, rather than comparing commit IDs directly.
Every original commit must have an accounted-for result, including commits that become empty after sanitization.
Its ordered parent list must map to the rewritten parent list. Any deliberate feature-base adjustment must be explicit in the integration record.
Original author and committer names, emails, dates, times, and timezone offsets must match exactly, including distinct author and committer timestamps.
The owner explicitly permits `tonywu@cs.stanford.edu`; do not rewrite it solely for privacy.
Do not normalize offsets or redate commits. Preserve the original merge structure.
A content rewrite invalidates existing commit signatures. Keep original signed objects in the backup and report any removed invalid signature as an exception.
Any lost commit, collapsed merge, unexplained ancestry change, or timestamp change prevents final replacement.
The final incorporated feature commits must remain reachable through their mapped counterparts, with no reintroduced private content.

No force-push, visibility change, or deletion of existing clones is authorized.
The local rehearsal authorization does not authorize shared-history replacement, provider changes, deployment, or telephone calls.
