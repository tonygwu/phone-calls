# Configure and deploy privately

For a first installation, use the ordered [README walkthrough](../README.md#set-up-your-own-service).
It uses `npm run setup` to collect configuration and record reviewed hashes without creating resources or deploying.
This page covers permissions, manual inputs, verification, recovery, and later maintenance.

## Credentials and permissions

Use `npx cf auth login` for an interactive Cloudflare login. A global `cf` installation is unnecessary.
The CLI has its own login; a browser dashboard session alone does not authenticate it.
The selected account must contain the service's domain and Zero Trust team.

Cloudflare credentials need Worker deployment, custom-domain configuration, and Access application management permissions.
For restricted tokens, the [Access user lookup](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/users/methods/list/) requires `Access: Audit Logs Read`.
Custom-domain changes also require zone-scoped [Workers Routes Write permission](https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains).
Provisioning uses the [Access application creation API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/).
Check its current permissions before creating a restricted token. Scope credentials to the selected account and zone.
`CLOUDFLARE_API_TOKEN` in `.dev.vars` overrides the CLI login for commands that load that file.

Twilio setup uses the live Account SID and Auth Token, with account inspection, number purchase/routing, and outbound-call permissions.
Test credentials cannot configure a production installation.
The ElevenLabs key needs user/subscription reads, Agents configuration and calls, phone-number management, and workspace webhook creation.
Its [key controls](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys) can restrict scopes and quota.
The scripts fail on provider refusal rather than broadening permissions automatically.

## Manual configuration

`npm run setup -- init` creates `.dev.vars` and `private/setup.json` without overwriting existing files.
The interactive `npm run setup` fills the setup file and resolves the Access owner ID through one read-only lookup.
If you prefer an editor, fill the fields below, run `npm run setup -- owner`, then run `npm run setup -- check`.

| Field | Value to supply |
| --- | --- |
| `publicOrigin` | Your unused service HTTPS origin, with no path or trailing slash. |
| `accessIssuer` | Your Zero Trust team's `https://TEAM.cloudflareaccess.com` origin. |
| `cloudflareAccountId` | The Cloudflare account ID containing the domain and team, rather than a zone ID. |
| `ownerEmail` | The exact email used to sign in to Access. |
| `ownerSubject` | The Access user ID; the `owner` helper resolves this after you sign in to the App Launcher. |
| `ownerName` | The name the phone assistant uses for you. |
| `selfNumber` | Your personal US number for `recipient: "self"` and optional conference invitations. |
| `callbackNumber` | Your personal callback number, rather than the new Twilio caller number. |
| `twilioAccountSid` | The same live Account SID as `.dev.vars`. |
| `selectedNumber` | An available US voice number to purchase, rather than a number you already own. |
| `voiceId` | A voice available to your ElevenLabs account. The wizard offers an editable stock default. |
| `oauthRedirectUris` | Exact HTTPS remote-client callbacks, or `[]` until your client displays its callback. |

The App Launcher needs an owner-only policy and your chosen login method before your first sign-in.
The owner helper requests at most two matching users and accepts only one exact email match.
It never chooses the first result from an ambiguous response. Raw lookup output stays in `private/setup-owner-response.json`.
The runtime still validates the configured owner email and subject; setup does not weaken owner authentication.

An empty remote redirect list permits no remote client registration through that list.
The provisioner separately permits localhost and loopback redirects for terminal MCP clients.
After ChatGPT supplies its exact callback, obtain a fresh review of that URI and the retained owner-only Access policy.
Apply the callback change through that reviewed update, with owner authorization for an agent's external change.
Record the same URI in the local setup file.
Do not rerun provisioning to add a callback.

## Before the first deployment

After resource creation, inspect these readbacks in the provider dashboards or their read-only APIs:

- The main Access application allows only the configured owner and has managed OAuth enabled.
- The only Access bypasses are the exact ElevenLabs and Twilio callback paths. Management and recording routes remain protected.
- The purchased number belongs to the selected Twilio account, rejects inbound voice, and has no SMS routing.
- The ElevenLabs agent has authentication, the expected prompt/models/voice/tools, and the requested 30-day retention.
- The signed webhook targets your own hostname, and all four Worker secrets match the generated private files.

Run `npm run setup -- build` to run the full check with your hostname/account and prepare `private/deploy-plan.json`.
This performs no upload. The prepared file carries the exact build, secret-file, emitted-configuration, and account hashes required by `scripts/deploy.mjs`.
After a fresh `ship` review, record its hash with `npm run setup -- review deploy REVIEWED_SHA256`.
The recorder checks that these inputs still match. It records approval without deploying.
For provision review, use `npm run setup -- review provision REVIEWED_SHA256` after the separate resource-plan review.
Neither recorder performs the review itself. Only the existing `provision:apply` and `deploy` commands perform those external changes.

The operator can also run the existing CLI dry run in the selected account:

```sh
npx cf deploy --prebuilt --secrets-file private/worker-secrets.json --dry-run
```

## Detailed deployment and maintenance

The service uses a dedicated Worker, Twilio number, ElevenLabs agent and three Access applications. With explicit user authorization, agents may deploy the Worker and update its existing ElevenLabs agent through the review gates below. Existing authentication alone authorizes neither action. New resources, real calls and scheduled work need their own explicit authorization. Provisioning and deployment never dial a phone number.

1. Copy `.dev.vars.example` to `.dev.vars`, set mode `600`, and fill provider credentials locally. Keep secrets, `private/`, dependencies and runtime state outside Git.
2. Sign into `cf` and verify `cf auth whoami` for the intended account. Run `npm run preflight` and `npm run inspect:accounts`. Local preflight validates existing service configuration with field diagnostics and fails on unsuccessful CLI authentication; missing service configuration is expected before provisioning. This local maintenance command does not run before calls. Inspect raw private account responses to verify the selected provider identities.
3. For a new installation, obtain authorization for the dedicated number and resources. Copy `examples/setup.json` to `private/setup.json` and resolve its owner subject, issuer, hostname, account, number, voice and exact OAuth redirect URI. An existing deployment does not need provisioning again; retain its existing `private/setup.json` because the deployment helper reads its selected Cloudflare account ID.
4. Run `npm run provision:prepare`. Review the exact resource plan with a fresh adversarial reviewer. Save `{ "verdict": "ship", "planSha256": "<reviewed hash>" }` to `private/provision-review.json`, then run `npm run provision:apply`. Uncertain resource creation must be reconciled before resuming. Do not repeat it automatically.
5. Inspect the Access policies, outbound-only number routing, agent authentication, recording disclosure, model, voice, telephone tools and retention. These are deployment readbacks, not per-call readiness gates. Configuration has no budget or approved-agent fingerprint fields.
6. Run `PHONE_CALLS_HOSTNAME=<chosen-hostname> npm run check`. Inspect `.cloudflare/output/v0/workers/default/worker.config.json` for the exact custom domain and disabled workers.dev and preview URLs. Run `cf deploy --prebuilt --secrets-file private/worker-secrets.json --dry-run` in the explicit selected account.
7. Obtain a fresh deployment review covering the exact source, build, secrets, account and readbacks. Save `private/deploy-review.json` with `verdict: "ship"`, `buildSha256`, `secretsSha256`, `workerConfigSha256`, and `cloudflareAccountId`. Run `npm run deploy` once and reconcile any uncertain result before repeating.
8. Read back the deployed Worker and version. Preserve the existing Durable Object namespace and owner subject when updating an installation. Verify owner authentication, signed callbacks, recording protection, custom domain, and disabled alternate URLs. Discover the four MCP tools and call `phone_calls_list_calls` as a read-only connection check. There is no setup-readiness tool.
9. Place a real call only when the user requested it. Inspect the returned call ID and poll its result. Every separate start invocation creates another call, so do not use a repeated start to check progress.

Cloudflare can [defer an active Durable Object's code update](https://developers.cloudflare.com/changelog/post/2026-10-30-durable-objects-deferred-code-updates/) for up to 300 seconds by default. A Worker version serving 100% of traffic does not alone prove that an active `CallLedger` has adopted it. Confirm the intended behavior through the ledger before live acceptance testing. If it still runs the previous code within that window, wait for adoption and observe the existing record instead of redeploying or starting a test against the old code.

The storage upgrade removes request uniqueness and budget tables inside one SQLite transaction while preserving call IDs and history. A rollback must retain this simplified schema or restore a separately verified database backup; the old release expects removed columns and cannot simply be redeployed against the upgraded database.

### Recover a stopped installation

If provisioning stops, inspect `private/provision-journal.json` and provider state.
An `intent` entry means that the result is uncertain. Read the corresponding provider resources before any further mutation.
Do not erase the journal, rerun creation to inspect its outcome, or change the plan to purchase a replacement automatically.
A confirmed creation must be reconciled into its existing journal step using the exact provider response.
Obtain a fresh review before a changed plan or any replacement resource request.
The helper deliberately provides no reset or force-retry command.

If deployment has an uncertain result, inspect the live Worker version and custom domain before repeating it.
Retain the exact reviewed build and private files until the outcome is known.

To retire the service, disable the Access allow policy, terminate active calls and confirm termination, then disable the dedicated agent.
Release the dedicated number only after confirming it belongs exclusively to this service.

### Optional conferences and agent maintenance

Direct SIP owner conferences require an encrypted inbound SIP route, an initialization-header secret, and a saved `connect_owner` tool. Prepare the exact plan with `npm run conference:sip -- prepare`. Follow the separately reviewed [conference activation procedure](OWNER-CONFERENCES.md). The helper preserves unrelated agent configuration and creates no telephone call. Then build, review, and deploy the resulting Worker configuration and secrets. The existing callback path accepts the authenticated initialization request. No number purchase or inbound-number reassignment is necessary. Ordinary outbound requests already supply initiation data and bypass this webhook. Legacy App records retain their separate receiving-call cleanup.

To update the existing ElevenLabs agent, run `npm run agent:plan`. This reads the selected user, workspace and agent and writes the exact nested PATCH and current configuration fingerprint to `private/agent-update/plan.json`. It creates no resources and places no calls. Review that concrete plan with a fresh adversarial reviewer, then save `{ "verdict": "ship", "planSha256": "<reviewed hash>" }` as `private/agent-review.json` and run `npm run agent:apply`. The update checks the same user, workspace, agent, configuration and repository definition before sending one PATCH. It reads the agent again and requires the exact repository prompt and all managed settings. It also checks that provider defaults, workflow and webhook routing survive.

Agent maintenance preserves installed webhook tool IDs, including the owner-connection tool. Resource setup owns tool attachment. The exact preservation check fails if a provider update drops a tool. Older desired-configuration hashes require a new plan and review after this change.

Run `npm run agent:readback` to check the current agent against the planned repository definition. Raw account and agent responses stay in `private/agent-update/`. The configuration fingerprint is maintenance evidence and does not run as call admission. If a PATCH response is lost or its readback fails, the intent journal refuses another update. Read back the live agent and reconcile the existing operation before planning or applying again. If the readback matches the desired configuration and retained controls, `agent:readback` records that reconciliation without sending another PATCH. Review a rollback as another plan using the prior repository definition. Neither Worker deployment nor provisioning updates an existing agent prompt automatically.

Before deploying a Worker that sends reminder prompt overrides, run `npm run agent:plan -- --permission-only`. Review that exact plan, write its hash and `ship` verdict to the same private review file, then run `npm run agent:apply` and `npm run agent:readback`. This preliminary plan changes only the prompt-text override permission. It preserves the current prompt, model, tools, authentication, privacy and other permissions. Archive the private plan and raw readbacks before the next plan reuses those filenames.

Then deploy and verify the Worker so every new dispatch supplies the new dynamic variables. Create a fresh full plan with `npm run agent:plan`, obtain a new review, and apply and read it back. Plan scope is required and hashed under `agent-update-v2`; apply and readback derive it only from the saved plan. Older plans need a new plan and review. Reconcile any uncertain update using its existing updater before replacing it. The Worker and agent have separate readbacks. Do not treat a successful Worker deployment as proof that the hosted prompt changed.
