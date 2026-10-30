# Project instructions

This project uses the `agent-fleet-git` skill. Use one active writer per
checkout and Git as the coordination channel between checkouts.

Before working, read `../FLEET.md` from the repository root if it exists.
That optional machine-local file stays outside Git. Check the checkout's
role with `git config --local --get fleet.role` and its claim handle with
`git config --local --get fleet.handle`. If either is absent, establish the
local assignment before editing. Check live sessions, unfinished work and
claims; a role alone does not prove the checkout is available.

Fetch and rebase onto the configured upstream before editing. Stage only
files you changed, by name. Commit and push each completed unit immediately.
Use the `backlog-protocol` skill's `scripts/claim.py <ID>` before taking a
shared backlog item. Respect rejecting hooks and do not force-push shared
history. Report divergence above five local commits, and any remote commits
left unsynced for more than a day. Keep committed tooling independent of
absolute checkout paths, and register new shared tools here.

Install dependencies with `npm ci`. Run `npm run check` to typecheck, run the
local test suite and build the Worker. The project pins its Node runtime in
the lockfile. Use `cf` and `cloudflare.config.ts` for Cloudflare commands.

Keep `.dev.vars`, `private/`, dependencies and Cloudflare build or runtime
state out of Git. Start local credentials from `.dev.vars.example` when
needed and restrict the resulting file to mode 600. With explicit user
authorization, agents may deploy this Worker and update its existing ElevenLabs agent configuration through the review gates in
`docs/OPERATIONS.md` and `docs/DEPLOYMENT.md`. Real calls, new-resource
provisioning and scheduled work need their own explicit authorization.
Authentication or a checkout role alone grants none of these.

`npm test` includes the Worker suite and isolated operational tests. `test/runtime-provider.ts` supplies synthetic responses for real Durable Object route tests; unexpected hosts and endpoints fail without network fallback.

Use `npm run simulate -- plan|run|collect|summary` for reviewed conversation simulations. See `docs/EVALUATION.md`; this tool cannot place telephone calls.

Use `npm run conference:setup -- prepare|apply` for reviewed owner-conference
configuration. Preparation reads provider state; apply creates a TwiML App and
owner connection tool and updates the saved agent. It requires explicit resource
change authorization and an exact reviewed plan. It never places calls or deploys.

Use `skills/phone-call-brief/SKILL.md` to prepare concise call payloads with factual context and silent rules; installation and ChatGPT use are in `docs/CLIENTS.md`.

Use `npm run agent:plan`, `agent:apply` and `agent:readback` to review, update and verify the existing ElevenLabs agent; these commands never dial.
