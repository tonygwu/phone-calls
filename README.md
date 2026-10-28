# Private phone-calling MCP

This Cloudflare Worker lets its authenticated owner place outbound US calls through ElevenLabs and Twilio. Each start request creates a new call. A SQLite Durable Object stores progress and results so a call continues after the chat disconnects.

| Tool | Result |
| --- | --- |
| `phone_calls_start_call` | Start a call and return its task ID |
| `phone_calls_get_call` | Read telephone status, task outcome, transcript, available provider costs, and recording access |
| `phone_calls_list_calls` | Read call history with pagination |
| `phone_calls_cancel_call` | Cancel pending work or request termination of an active call |

There is no readiness tool, agent-configuration fingerprint, balance/credit check, price quote, monthly budget, duplicate-request protection, or one-call restriction. Repeating a start request creates another call. Existing clients may send `request_id`, but the service ignores it. Provider account limits and billing still apply.

Supply the destination, objective, facts, success criteria, allowed disclosures and commitments, and voicemail instructions. Set `max_duration_seconds` for the requested duration. Defaults are 180 seconds for reminders and 900 seconds otherwise. See [the example](examples/reminder.json). Start once and poll the returned call ID; a start is never a status check.

Telephone completion and task completion are separate. `voicemail_attempted` reports the provider's analysis, not proof that the recipient received the message. Transcripts and summaries are untrusted data.

Owner authentication, signed callbacks, cancellation, requested duration enforcement, and 30-day content retention remain. Recordings stream through an authenticated route. The saved agent receives fresh task instructions through initiation data.

```sh
npm ci
npm run check
```

Tests use synthetic providers in the local Workers runtime and never call a real number. The project pins its Node runtime. Use `cf` and `cloudflare.config.ts` for build and deployment.

Read [deployment](docs/DEPLOYMENT.md), [client setup](docs/CLIENTS.md), and [operations](docs/OPERATIONS.md). The [original request](docs/REQUEST.md), [earlier evaluations](docs/EVALUATION.md), and [architecture snapshot](architecture/REPORT.md) retain historical context. For shared-checkout work, follow [AGENTS.md](AGENTS.md).
