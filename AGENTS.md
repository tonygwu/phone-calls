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
needed and restrict the resulting file to mode 600. Existing authentication
or a checkout role does not authorize deployment, provisioning, scheduled
work or real calls. Follow the user's authorization and the operational
rules in `docs/OPERATIONS.md` and `docs/DEPLOYMENT.md`.
