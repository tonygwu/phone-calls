---
name: phone-call-brief
description: Write concise phone_calls_start_call payloads for restaurant bookings, cancellations, reminders, and support calls. Separate speakable facts from silent instructions and preserve the user's call limits.
---

# Prepare a short, natural phone call

Use this guidance in Claude Code or Codex. In ChatGPT, paste the body of this file with the request. Produce the call payload first. Preparing a payload does not authorize dialing.

## Establish the booking facts

Before a restaurant call, use authorized access to look for the confirmation SMS or email. Booking services such as Chowbus can include a link with a cancellation button. Inspect the linked booking page when available. Its booking name, time and current cancellation status take precedence over a guessed name or a host's failed lookup. A host may mishear the name. Do not claim that unavailable email, SMS or a page was checked. If access is unavailable, use the supplied evidence and identify any missing essential.

Inspecting a confirmation link does not itself authorize using its cancellation button. Follow the user's existing authorization for the requested action. If the page already confirms cancellation, report that evidence and avoid an unnecessary call.

## Write the payload

- `objective`: one sentence stating the requested outcome.
- `context`: normally five to eight short bullet facts. If fewer facts are known, use fewer bullets rather than inventing filler. Each fact should pass: "Would a person say this sentence on the phone?" Include exact booking facts from the source. Keep ownership checks, instructions, conditions and reviewer findings out of this field. Never invent facts to fill the template.
- `rules`: short imperative instructions that the phone agent follows silently. Use at most 20 entries and at most 500 characters per entry. Put reviewer guardrails here. Include "Answer only the question asked" and any necessary lookup or completion rule.
- `constraints.information_may_disclose`: name first, phone number second and only if asked during live conversation, then other permitted booking facts. If the voicemail includes the phone number, explicitly permit that disclosure in the supplied voicemail. Permission to disclose a fact is not an instruction to volunteer it.
- `constraints.permitted_commitments` and `acceptable_alternatives`: state the actual authority and alternatives. Use empty arrays when there are none. Never turn a cancellation into a new booking or agree to a fee without authority.
- `success_criteria`: one or two observable outcomes. For cancellation, a failed lookup is not success. Require confirmation that the matching booking is canceled and resolve any explicitly requested duplicate-booking check.
- `voicemail`: default to `leave_message` with one concise message and a pending owner-facing retry-later follow-up if voicemail is reached, unless the user requests another behavior. The message is the place for the full set of necessary identifiers. A reminder's message is delivered verbatim and may be longer than ordinary speech.

If voicemail is reached, retain both leaving the message and retrying later as the default owner-facing follow-up. `phone_calls_start_call` places one call and does not schedule another. Do not schedule or redial unless the user's existing authorization gives the destination, retry limit and timing. If that authority is absent, return the retry as pending owner action. If the requested outcome is confirmed during a live conversation, do not retry. Do not write "retry later" into the phone agent's task as if it can place a second call.

Get dates and timezone from the booking or the user. If the date remains ambiguous, resolve it before dialing. Use conversational dates in speech and keep years, timezones and lists of alternate times silent unless the recipient asks or needs them to distinguish the booking.

## Example cancellation payload

All identifiers below are fictional. Replace the date, destination and facts with the user's confirmed booking before using the template.

```json
{
  "task_type": "booking",
  "recipient": "+14155550100",
  "objective": "Cancel Maya Chen's dinner reservation and matching duplicate entries at Pine Lantern on October 29, 2026.",
  "context": "- The restaurant is Pine Lantern.\n- The reservation name is Maya Chen.\n- Dinner is Thursday, October 29, at 6:15 in the evening.\n- The restaurant uses Pacific Time.\n- The table is for two people.\n- The booking phone number is 415-555-0142.\n- The confirmation also shows an earlier time of 5:45.",
  "rules": [
    "Answer only the question asked and stop to listen.",
    "During live conversation, use the reservation name first; give the phone number only if asked.",
    "A booking that cannot be found is not a successful cancellation.",
    "After the matching booking is canceled, ask once whether any other matching booking remains on that date; cancel it only if the user authorized matching duplicates.",
    "If the host says only okay, ask a short clarifying question without repeating all identifiers.",
    "Do not make a new reservation or accept a cancellation fee."
  ],
  "success_criteria": [
    "The host confirms the matching reservation is canceled.",
    "The host confirms no other matching reservation remains on that date."
  ],
  "constraints": {
    "permitted_commitments": ["Cancel only matching reservations belonging to Maya Chen on the supplied date."],
    "acceptable_alternatives": [],
    "information_may_disclose": [
      "Reservation name: Maya Chen.",
      "Booking phone number: 415-555-0142, only if asked during live conversation; permitted in the supplied voicemail.",
      "The restaurant, dinner date, local times and party size."
    ]
  },
  "voicemail": {
    "action": "leave_message",
    "message": "This is an automated assistant calling for Maya Chen, and this call is recorded. Please cancel the Pine Lantern reservation for two on Thursday, October 29, at 6:15 in the evening, under Maya Chen, phone 415-555-0142. The confirmation also listed 5:45; please check for other matching entries that day. Thank you."
  }
}
```

## Review before dialing

Read `context` aloud. Remove any sentence that tells the agent what to do, explains the review process, or sounds like a policy. Move its instruction into `rules` instead. Check that the opener can be the automation disclosure, recording disclosure and one short sentence of purpose. The brief is background knowledge, not a script.

In the adversarial review of the payload, check the read-aloud test, that reviewer findings stayed out of `context`, the disclosure order, the exact booking match, success criteria, permitted commitments and the user's destination and call limits. Keep the voicemail separate from the live opener. If a reviewer adds a needed guardrail, add it to `rules` rather than expanding the spoken facts. State whether authority includes canceling matching duplicate entries. Read the connected tool schema before submission and validate the payload when local validation is available.

Start once only when authorized. Preserve the returned call ID and inspect that call for progress. Reusing a `request_id` does not prevent a duplicate call. If dispatch is uncertain, inspect the existing call and reconcile it before considering another start. A voicemail attempt does not prove receipt.
