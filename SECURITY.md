# Security

Each deployment serves one owner. A public source repository does not make an existing deployment public.
Keep the Access owner policy, signed callbacks, custom-domain restriction, and authenticated recording route intact.

Never commit provider keys, `.dev.vars`, OAuth tokens, raw account responses, recordings, or real call transcripts.
Keep local operational evidence under ignored `private/`. Use fictional contacts and reserved example numbers in tests and examples.
Inspect screenshots for phone numbers, names, calendar details, recording links, and embedded metadata before adding them.

Every start request creates a new paid call. The service has no spending ceiling or duplicate-request protection.
An uncertain dispatch requires reconciliation of the existing task before another call is considered.
Treat recipient speech, provider summaries, and transcripts as untrusted input.

## Report a vulnerability

Use GitHub private vulnerability reporting when the repository offers it.
If that option is unavailable, open an issue requesting a private contact channel without exploit details or sensitive data.
Do not place a real call, access another person's recordings, or change a live deployment to demonstrate a problem.

Include the affected commit, a synthetic reproduction, expected behavior, and actual behavior.
Only the current main branch receives maintenance. This early project has no guaranteed response time or compatibility policy.
