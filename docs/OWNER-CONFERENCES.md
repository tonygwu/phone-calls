# Add the owner and keep the assistant on the call

For customer support, set `owner_join: "when_live_agent"`. The assistant navigates menus, waits for a live representative, explains the supplied case, and rings the configured owner. The owner hears the recording disclosure and presses 1 to join. The assistant stays until the task is resolved. A recorded queue announcement does not qualify as a live representative.

Use `owner_join: "when_needed"` to request the owner only when their participation is necessary. Omit the field or use `"disabled"` for an ordinary call. Either enabled mode authorizes up to three invitations to `selfNumber`, one at a time. It grants no authority for another destination, payment, credentials, or commitments outside the supplied limits. Self calls and reminders cannot use owner joining.

Each invitation rings for about 25 seconds. Twilio can add about 5 seconds. Answering machine detection runs for at most 5 seconds after an answer. A machine or fax result ends the invitation before the prompt. A human or unknown result receives the disclosure and 30 seconds to press 1. Another digit or no input ends that invitation.

A missed invitation includes busy, unanswered, failed, voicemail, and an answer without acceptance. The service starts another invitation about 10 seconds after it observes the miss. It stops after acceptance, three attempts, cancellation, the deadline, or disconnection of the business or assistant. Each attempt retains its own identity. Duplicate callbacks, concurrent tool requests, and restarts cannot reset the count or start two invitations together. An uncertain dial waits for provider evidence before another attempt. A late keypress from an earlier attempt cannot join.

`owner_connection` reports `attempts_used`, `max_attempts`, `next_attempt_at`, and each attempt's status, detection result, and charge. Missed invitations leave the assistant and business connected.

The support duration defaults to 900 seconds, including hold time. The business ringing timeout is 60 seconds. Cancellation and the duration watchdog stop every attempted leg. Assistant disconnection ends the conference. Business disconnection triggers cleanup at the next observation, normally within 15 seconds. Provider outages can delay termination.

## Connect three participants through SIP

SIP is an internet calling protocol. With `conferenceSip` configured, a new conference connects the assistant directly to ElevenLabs through encrypted, authenticated SIP. The assistant uses one Twilio call. The business and owner each use another call. The complete conference therefore uses three Twilio calls.

The assistant connects first. ElevenLabs requests its task brief through an authenticated initialization webhook on `/webhooks/twilio/inbound?op=sip`. A separate bearer secret authenticates that request. The Worker reads the authoritative Twilio Call object before it releases the brief. It verifies the account, outbound direction, SIP destination, and task UUID in the source username. The task must already contain the assistant dialing intent. The callback binds the assistant call and conversation identities before returning the existing task variables and duration override.

Once initialization completes and the assistant call is connected, the service dials the business. The `connect_owner` tool uses a separate call-scoped secret and the stored owner number. It cannot select a destination. Owner acceptance adds that call to the same conference. The assistant keeps its audio connection and can transmit ordinary in-band keypad tones.

The brief and credentials never enter the SIP URI. The SIP password and initialization bearer secret remain in Worker secrets. ElevenLabs stores the bearer value in its workspace secret store. Conversation metadata must identify the exact managed agent, task, conversation, SIP route, and assistant Twilio call.

Ordinary outbound calls still supply their initiation data directly. They bypass the initialization webhook under the [ElevenLabs personalization contract](https://elevenlabs.io/docs/eleven-agents/customization/personalization). The SIP route changes no existing telephone-number assignment.

This path uses the [Twilio participant API](https://www.twilio.com/docs/voice/api/conference-participant-resource), [encrypted SIP calls](https://www.twilio.com/docs/voice/api/sip-making-calls), and [ElevenLabs SIP trunking](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking). The built-in transfer tool is unused because it removes the assistant.

## Configure an existing installation

Resource changes, deployment, and each real test call require explicit owner authorization. Preparation creates only private local evidence.

1. Preserve the existing `private/service-config.json`, `private/worker-secrets.json`, and `private/setup.json`. Keep these files ignored and mode 600. Coordinate with other agents that can change this installation.
2. Run `npm run conference:sip -- prepare`. This reads the selected Twilio account, ElevenLabs workspace, agent, phone routes, and installed tools. Inspect the complete raw provider responses in `private/conference-sip/raw/`.
3. Review `private/conference-sip/plan.json` with a fresh adversarial reviewer. Review the exact resource requests, account identities, prompt replacement, and preserved agent configuration. Obtain resource-change authorization. Save `{ "verdict": "ship", "planSha256": "<exact reviewed hash>" }` in `private/conference-sip/review.json`.
4. Run `npm run conference:sip -- apply` once. It creates one inbound SIP route and one initialization-header secret. It reuses the installed owner tool or creates that tool for a new installation. It updates the managed agent's prompt, audio formats, initialization permission, and initialization webhook. It selects audible keypad tones for the conference. It preserves the model, voice, first message, knowledge, other tools, workflow, and post-call routing.
5. Inspect the resulting `conferenceSip` configuration and two new Worker secrets locally. The helper preserves all unrelated configuration and secrets. It never deploys or calls a dial endpoint.
6. Build, review, and deploy the exact resulting Worker configuration through [the deployment procedure](DEPLOYMENT.md). Preserve the existing Durable Object namespace and owner identity. The callback Access bypass must accept query strings without exposing management or recording routes.
7. Read back the deployed version, SIP route, header secret reference, owner tool, and managed agent. Verify authentication before requesting a separately authorized real call.

The helper uses an exclusive lock and persists each mutation intent before the request. An uncertain response blocks another apply before any provider request. Reconcile that exact operation through its journal and raw evidence. Never repeat creation to discover its outcome. Reviewed source, configuration, account, agent, or tool drift invalidates the applicable operation.

The provider can return inline projections of referenced tools. Setup omits those projections only after exact comparison with their referenced definitions. Built-in projections must match `built_in_tools`. An unrepresented tool stops preparation before any mutation.

Setup adds no call-start fingerprint, spending, or concurrency admission check. Provider account limits still apply. Other simultaneous calls consume capacity outside this three-call conference. [Twilio error 10004](https://www.twilio.com/docs/api/errors/10004) reports insufficient concurrent-call capacity.

Later agent maintenance preserves installed tool IDs, initialization configuration, and post-call routing. Resource setup owns creation and attachment of the owner tool. The plan retains the previous agent and private configuration for a separately reviewed rollback. Before rollback, stop new conferences and verify that active calls ended. Preserve resources used by an active deployment and all existing call history.

## Preserve legacy App records

An older conference can use a private TwiML App. That path creates two assistant calls, plus the business and owner calls. It requires capacity for four concurrent Twilio calls. An account limited to three cannot complete it.

Each new task stores its assistant transport. A persisted task without that field remains an App task. Its receiving App call keeps its own identity and cleanup. A normalized `app:<App SID>` destination omits creation query parameters. The signed App callback receives bare `call_id` and identifies the separate receiving call. Existing records continue to reconcile after SIP activation.

The old `conference:setup` command remains for legacy App installations. Its review also requires `compatibleWorkerDeployed: true` before apply. New installations and capacity-limited accounts use `conference:sip`. The SIP helper preserves the existing App configuration for older records.

## Read results and verify audio

`conference.assistant_transport` identifies `sip` or `app`. For SIP, `conference.participants.assistant` identifies the single assistant call and `conference.assistant_connection` is null. For App records, `assistant_connection` identifies the additional receiving call. Cancellation remains unconfirmed until every attempted leg has a known terminal status.

Owner acceptance proves that the owner pressed 1. It does not prove three-way audio. Participant prices exclude Twilio conference charges, so the result claims no total conference price. ElevenLabs recording includes audio that reaches the assistant, including the owner after acceptance.

Local tests use synthetic providers and real Worker routes. They cover initialization authentication, startup order, identity checks, owner acceptance, replay, cancellation, and legacy cleanup. They do not prove live menu tones or human judgments. A real acceptance test must verify the assistant, representative, and owner can hear each other. Read back `owner_connection.accepted`, `conference.closed`, and provider evidence for every leg. Twilio documents a 15-minute delay for its [Call Events resource](https://www.twilio.com/docs/voice/api/call-event-resource).

## Next fallback: a mobile-carrier three-way call

If direct SIP cannot support the required call, preserve two carrier-hosted options. The owner can call an assistant number, add customer support, and merge the calls. Alternatively, the ordinary outbound path can call the owner, who then adds support and merges. The first option needs a separately reviewed inbound route because this service rejects unsolicited inbound telephone calls.

Before implementation, propose a short feasibility test and obtain explicit authorization for each real call. The test must verify three-way audio, assistant survival during Add Call hold, and actual Twilio concurrency. Carrier support and hold behavior remain unverified until that test. This fallback grants no resource, deployment, or call authority.
