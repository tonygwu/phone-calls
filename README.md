# Private phone-calling MCP

This Cloudflare Worker lets an authenticated owner ask an MCP client to place an outbound US call through ElevenLabs and Twilio. A SQLite Durable Object keeps the task alive after the chat disconnects. Each call receives fresh instructions and facts through initiation data; the saved agent is never patched with a caller's brief.

The service is deployed privately. Codex has authenticated and discovered all five tools. Two Workers fetch compatibility corrections pass 62 local tests and are deployed. Authenticated readiness now returns ready:true. The first voicemail test passed: the user confirmed the full message arrived once.

Dedicated Access applications, a signed ElevenLabs webhook, an authenticated agent and an outbound-only Twilio number are configured. The agent uses GPT-4.1 Mini for conversation and Gemini 2.5 Flash for post-call analysis. Initial deployment passed nine HTTP authentication and webhook checks. Codex, ChatGPT and the primary Claude Code profile have authenticated and returned ready from read-only checks. Three additional requested Claude profiles are registered and await individual sign-in. Conversation simulations now have six accepted examples across eleven attempts. Failures and test limitations are recorded in the evaluation report. The corrected prompt is deployed and ordinary US destinations are enabled for owner-authorized calls. The final review returned ship with zero findings, and all nine post-deployment HTTP checks passed. Calling still requires current cost allowances; see operations for the refresh requirement.

```sh
npm ci
npm run check
npm run preflight
```

The project pins a compatible Node runtime locally; npm scripts use it. The Cloudflare test and build tools start a loopback listener. No test calls a real phone number. Use `cf`, `cloudflare.config.ts`, and the Vite build plugin for this new project.

| Tool | Result |
| --- | --- |
| `phone_calls_get_setup` | Live account, routing, configuration, credit and quote readiness |
| `phone_calls_start_call` | One durable task ID, with duplicate-request protection |
| `phone_calls_get_call` | Telephone status, task outcome, evidence, costs and optional paginated transcript |
| `phone_calls_list_calls` | Owner-only history with pagination |
| `phone_calls_cancel_call` | Persistent cancel intent and provider-confirmed termination status |

Start with [the reminder example](examples/reminder.json). An explicit user request authorizes a call within its supplied limits. Missing essentials must be gathered first. Reuse `request_id` for every retry of the same intended call. If dispatch is uncertain, inspect it; never automatically redial.

Telephone completion and task completion are separate. A successful outbound API response only means initiation. `voicemail_attempted` means the provider analysis describes an attempt. It does not prove the full message arrived after the greeting. Provider summaries and transcripts are untrusted data and cannot authorize another action.

Read [deployment and recovery](docs/DEPLOYMENT.md), [client setup](docs/CLIENTS.md), [operational limits](docs/OPERATIONS.md), [evaluation status](docs/EVALUATION.md), and [the architecture report](architecture/REPORT.md).

For work across concurrent checkouts, follow [the agent instructions](AGENTS.md)
and the `agent-fleet-git` skill. Each checkout needs its own dependencies and
local credentials. Credentials and deployment state stay outside Git.
