# Phone Calls MCP

Make phone calls from Claude Code, ChatGPT, or Codex through a self-hosted [Model Context Protocol](https://modelcontextprotocol.io/) server.
The service uses ElevenLabs for the voice assistant, Twilio for telephone calls, and Cloudflare Workers for hosting.
It can cancel restaurant reservations, make bookings, deliver reminders, or navigate customer support.
Calls continue after the chat disconnects, and the assistant can retrieve their results later.

Each installation serves one authenticated owner. You deploy your own service and connect your own provider accounts.
This is an early project with a manual deployment process. Two API keys alone do not complete the installation.

## Example: cancel a restaurant reservation from Claude Code

Here is an example where I use this MCP connector in Claude Code to cancel a restaurant reservation.
Claude Code makes the call, polls its status, and reports the restaurant's response.
The screenshots show a real use of the connector. Private details are cropped or covered, and image metadata is removed.

![Claude Code polls an active phone call until the restaurant confirms cancellation](docs/images/claude-code-call-progress.png)

![Claude Code reports the cancellation, with identifying details covered](docs/images/claude-code-cancellation-result.png)

The result reflects the recipient's statements in the provider transcript. A completed telephone call alone does not establish task success.

For a similar request, supply the restaurant's number, reservation name, date, local time, permitted disclosures, and any limits on fees or changes.
The [fictional cancellation example](examples/cancellation.json) shows the complete tool input, including silent rules and success criteria.

## Tools

| Tool | Result |
| --- | --- |
| `phone_calls_start_call` | Start a call and return its task ID |
| `phone_calls_get_call` | Read telephone status, task outcome, transcript, available provider costs, and recording access |
| `phone_calls_list_calls` | Read call history with pagination |
| `phone_calls_cancel_call` | Cancel pending work or request termination of an active call |

Supply a short objective, factual context, success criteria, permitted disclosures and commitments, and voicemail instructions.
Put behavioral instructions in `rules`. See the [reminder](examples/reminder.json) and [call-brief skill](skills/phone-call-brief/SKILL.md).

Start once, then poll the returned call ID with `phone_calls_get_call`.
**Every start creates another call**, including repeated inputs and repeated `request_id` values.
The service ignores `request_id`; it does not prevent duplicates.

For customer support, `owner_join: "when_live_agent"` rings you after a live representative answers.
Use `"when_needed"` to join only when your participation is required.
The service permits up to three invitations, one at a time. You must answer and press **1** to join.
The assistant stays in the conference. This feature requires separate [conference setup](docs/OWNER-CONFERENCES.md).
The current connection method needs capacity for four simultaneous Twilio calls.
Accounts limited to three concurrent calls cannot complete owner joining. See the conference guide before enabling this feature.
See the [support example](examples/support-with-owner.json).

## Requirements

- A Cloudflare account, a domain in that account, and Cloudflare Access with an owner login.
- A funded Twilio account and a dedicated US voice number.
- An ElevenLabs account with Agents access, a suitable API key, and access to the configured models and voice.
- Node.js 24.22.0 for development, plus npm.
- An MCP client with remote HTTP and OAuth support. ChatGPT account and workspace policies determine custom-server access.

Setup supplies your hostname, owner identity, phone numbers, provider identities, and voice through private configuration.
The conversational model, analysis model, and speech model currently live in [src/agent.ts](src/agent.ts).
They are source defaults, not setup options. Changing a model requires another evaluation and reviewed agent update.

Only valid United States destinations are supported. Canada and other countries that share the `+1` prefix are excluded.
Each installation supports one owner, rather than a shared service where visitors bring their own API keys.

## Install and connect

Clone the repository, then run the local checks. These commands need no provider credentials and place no calls.

```sh
npm ci
npm run check
```

For a new installation:

1. Copy [.dev.vars.example](.dev.vars.example) to `.dev.vars` and restrict it with `chmod 600 .dev.vars`.
2. Add the provider credentials locally. Never paste these keys into a chat or client configuration.
3. Copy [examples/setup.json](examples/setup.json) to `private/setup.json` and replace every example value.
4. Follow [deployment](docs/DEPLOYMENT.md) to inspect accounts, review provisioning, configure Access, build, and deploy.
5. Follow [client setup](docs/CLIENTS.md) to connect the deployed `https://<your-hostname>/mcp` endpoint through OAuth.
6. Ask the client: “List my phone-call history. Do not place a call.”

Provisioning creates provider resources and purchases a dedicated number. It needs separate authorization and an exact reviewed plan.
Deployment uses `cf` and [cloudflare.config.ts](cloudflare.config.ts). The raw provider keys stay on the server.
`npm run dev` alone does not configure a working installation; the runtime also requires a complete `SERVICE_CONFIG` and webhook secrets.

For ChatGPT, add a custom MCP server at [ChatGPT Plugins](https://chatgpt.com/plugins), enter the deployed endpoint, and select OAuth.
Allow the exact callback URI for that installation in Cloudflare Access.
See the [official connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt) for current interface details.

For Claude Code:

```sh
claude mcp add --transport http --scope user phone_calls https://<your-hostname>/mcp
claude mcp login phone_calls
```

For Codex:

```sh
codex mcp add phone_calls --url https://<your-hostname>/mcp
codex mcp login phone_calls
```

## Costs, privacy, and limits

Twilio, ElevenLabs, and Cloudflare have their own charges and account limits.
The service has no spending ceiling, balance check, price quote, duplicate-request protection, or limit of one active call.
Requested durations default to 180 seconds for reminders and 900 seconds for other calls.
A positive `max_duration_seconds` requests another duration without an application-level maximum; provider limits still apply.

The Worker validates the owner's signed Access token and provider callback signatures.
Recordings require owner authentication. Task content expires after 30 days, and the agent definition requests separate provider retention for that period.
Call details pass through Cloudflare, Twilio, and ElevenLabs; this is not an offline or local-only service.
The agent instructions require identification as an automated assistant and disclosure of recording.
Operators remain responsible for the calls and recording practices they authorize.

Transcripts and summaries are untrusted data. `voicemail_attempted` does not prove that a recipient received the message.
Tests and screenshots do not guarantee future speech quality, delivery, or business outcomes.
Read [security guidance](SECURITY.md) and [operations](docs/OPERATIONS.md) before a real call.

## Development and release status

The tests use synthetic providers in the local Workers runtime and isolated directories for operational commands.
Unexpected outbound requests fail without a real-network fallback.
`npm run check` runs TypeScript checks, both test suites, and the Worker build.
The [public-release review](docs/PUBLIC-RELEASE.md) records measured coverage, privacy findings, setup gaps, and remaining publication decisions.

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before changes.
The [evaluations](docs/EVALUATION.md), [original request](docs/REQUEST.md), and [architecture snapshot](architecture/REPORT.md) preserve historical evidence.
Their older budgets, readiness tools, model choices, and deployment claims do not describe the current release contract.

## License

[MIT](LICENSE).
