# Call behavior and recovery

Only the configured owner can manage calls or read recordings. The Worker validates the signed Access issuer, audience, expiry, email and subject. It rejects other hostnames and browser origins. The two provider callback paths accept signed POST requests only. Twilio recording is disabled; ElevenLabs recordings stream through an authenticated route.

Every start invocation creates a new task and a new call, including repeated inputs or `request_id` labels. Calls may overlap. There are no setup-readiness, agent-fingerprint, budget, price, balance, credit, duplicate-request, or active-call admission checks. The service does not perform automatic top-ups or account upgrades. Provider billing and account limits apply directly.

Each task is saved before dispatch. A task's status processing observes its existing call; it does not create another call. If dispatch is uncertain, inspect that task. Another start request always creates a separate call. Cancellation persists until the provider identifies the call and confirms termination.

Call duration defaults to 180 seconds for reminders and 900 seconds for other tasks. A positive `max_duration_seconds` requests another duration without an application-level ceiling; provider limits may reject unsupported values. ElevenLabs receives the duration override, and a persistent watchdog also requests termination through Twilio after the requested duration plus the 60-second ringing allowance. Provider outages can delay watchdog execution. All due active tasks are checked concurrently every 15 seconds; completed analysis runs one task at a time while no call is active. Terminal analysis checks run every minute for a day and hourly afterward.

Call results separate telephone status from task outcome. Provider summaries do not establish mailbox receipt. Costs are reported when available and may be provisional; missing prices do not prevent result collection from finishing. There is no monthly accounting or reserved allowance. A durable observation sequence keeps older responses from replacing newer results.

Task briefs, results and transcripts expire 30 days after acceptance, including unresolved tasks. Expiry does not block new calls or retain duplicate-request hashes. The first use of an older database atomically copies existing call history into the simplified table and removes obsolete request, budget, and blocking tables. Call IDs, timestamps and stored contents are preserved. ElevenLabs has its separately configured 30-day retention policy; the service no longer polls that configuration before calls.

MCP bodies are limited to 64 KiB and callbacks to 2 MiB. Audio callbacks are disabled. History and transcript pages contain at most 100 records, with explicit cursors or offsets. Provider errors return sanitized categories rather than credentials or raw error bodies. Cloudflare request logging remains disabled.
