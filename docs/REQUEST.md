# User implementation request

This is the original implementation request. On 2026-10-28 the user authorized removal of readiness/configuration gates, duplicate-call controls and spending controls. Those older requirements below are superseded. The repository now selects GPT-4.1 with concise conversation rules after the measured Mini-model candidates failed repetition checks. See README.md, docs/OPERATIONS.md and docs/EVALUATION.md for current behavior and rollout evidence.

The user explicitly requested implementation of the following approved plan. Subsequent input supplied a private Google Voice test destination and allowed a humorous reminder. The user upgraded Twilio and explicitly approved a $20 starting deposit; the service's additional monthly budget remains $10. The side browser is now connected after the user enabled its plugin, and provider credentials and Cloudflare authentication are established. The user will install the ChatGPT MCP connection manually after a side-browser sign-in error. The private number is intentionally omitted here. The original plan text below preserves the earlier setup assumptions.

## Phone-calling MCP on Cloudflare, starting with voicemail

Build one private MCP service that Claude Code, ChatGPT, and Codex can use to make calls through ElevenLabs and Twilio. It will run directly on Cloudflare Workers and remain available when your Mac is offline.

The first acceptance test is: **“Call my phone and leave me a voicemail reminding me to do XYZ.”** Restaurant bookings and customer-support inquiries will use the same interface.

Reuse an ElevenLabs agent configuration, with fresh instructions, context, and conversation history for every call.

## Implementation

- Use TypeScript, Zod, the official MCP SDK, and Cloudflare’s Streamable HTTP handler. Store call tasks, results, and duplicate-request protection in a SQLite Durable Object.
- Create a separate Cloudflare Access application using your existing account and login approach. Restrict access to you, validate authentication inside the Worker, and disable alternate deployment URLs that could bypass authentication.
- Provision one dedicated US Twilio number and connect it to ElevenLabs. Store credentials as Cloudflare secrets. Configure outbound-only operation: reject incoming calls, disable SMS conversations, and require authentication for ElevenLabs web sessions.
- Configure the agent with a stock English voice, GPT-4.1 Mini, and phone controls for hanging up, voicemail, keypad menus, and waiting. Pin the configuration and disable automatic model substitution for the initial evaluation.
- Pass each task through ElevenLabs’ conversation-initiation data. Never modify the shared agent configuration to insert an individual call’s context.
- Receive signed completion and failure callbacks. Persist results before acknowledging callbacks, handle duplicate or out-of-order events, and reconcile missing events through provider APIs.
- Retain audio and transcripts in ElevenLabs for 30 days. Retain service task details and results for the same period. Stream recordings through an authenticated route; disable duplicate Twilio recordings.

## MCP interface

| Tool | Purpose |
|---|---|
| `phone_calls_get_setup` | Report account, agent, number, credit, budget, and configuration readiness. |
| `phone_calls_start_call` | Start one call with a destination, objective, context, and explicit limits. |
| `phone_calls_get_call` | Retrieve progress, outcome, confirmation details, unresolved questions, transcript, and recording access. |
| `phone_calls_list_calls` | Return paginated call history. |
| `phone_calls_cancel_call` | Cancel a pending call or terminate an active call, then verify provider status. |

`phone_calls_start_call` accepts:

- `request_id`: stable identifier that prevents duplicate calls when a client retries.
- `task_type`: reminder, booking, support, or general.
- `recipient`: `"self"` or a complete international-format US number.
- `objective`, `context`, and `success_criteria`.
- `constraints`: permitted commitments, acceptable alternatives, and information the agent may disclose.
- `voicemail`: hang up or leave a supplied message.
- Optional `max_duration_seconds`.

It returns a call identifier immediately. Clients retrieve progress and results through `phone_calls_get_call`; the call continues if the originating chat disconnects.

Every result separates **telephone status** from **task outcome**. A connected or completed telephone call does not prove that a voicemail arrived or a reservation succeeded.

## Call behavior and safeguards

- Treat an explicit request to call as authorization within the supplied limits. Gather missing essentials before dialing.
- Identify the caller as an automated assistant acting for you and disclose recording. Use only supplied facts. If additional authorization or authentication is required, return `needs_user_input`.
- For reminders, wait for the voicemail greeting to finish, speak the supplied reminder once, and hang up. If a person answers, deliver it once and report delivery to a person separately.
- Default business calls to leaving no voicemail unless a message was supplied. Use your configured personal callback number when a callback is needed.
- Start with one active call at a time, a three-minute reminder limit, a fifteen-minute general-call limit, and a thirty-minute maximum. Set a sixty-second ringing timeout.
- Enforce duration through ElevenLabs settings and a persistent Cloudflare watchdog that requests termination through Twilio. Do not report termination until provider evidence confirms it.
- Persist each dispatch before contacting the provider. If dispatch times out ambiguously, preserve an unknown state and reconcile it. Never automatically redial.
- Verify signatures on the two exact provider callback paths. All call-management and recording routes require owner authentication.
- Check current rates, credits, and remaining budget before dialing. Track incurred charges and reserved call allowances against the $10 additional monthly budget. Surface unknown costs and funding requirements before spending.

## Testing and rollout

1. **Build locally with simulated providers.** Test input validation, authentication, duplicate requests, uncertain dispatch, callback races, restart recovery, cancellation, enforced time limits, budget exhaustion, and retention.
2. **Configure accounts and deploy privately.** Read back the selected account, agent, voice, model, number routing, authentication, and retention settings. Complete a fresh adversarial review before consequential changes and paid tests.
3. **Connect all three clients.** Install the same remote endpoint separately in Claude Code, ChatGPT, and Codex. Supply private plugin configuration and usage instructions. Test tool selection without placing a paid call from every client.
4. **Run the first voicemail evaluation.** Initially allow calls only to your test number. Place one requested reminder call, inspect provider responses and the conversation evidence, and have you confirm the complete message arrived after the greeting. Until then, report `voicemail_attempted`, not verified delivery.
5. **Exercise conversational tasks.** Simulate restaurant availability, acceptable alternatives, booking confirmations, support menus, unavailable information, and requests exceeding your authority. Enable ordinary US destinations after the initial acceptance test passes.

Report evaluations as attempted, succeeded, and failed, with failure reasons. Preserve sanitized evidence and document deployment, architecture, and client setup.

Execution still needs your test phone number, reminder text, and account credentials or interactive login access. This session has not accessed or changed your ElevenLabs account because side-browser controls are unavailable.
