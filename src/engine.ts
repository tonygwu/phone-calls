import { CallError, DAY, RETENTION, canonical, costsSettled, digest, monthAt, publicError, startSchema, terminal, type StartInput, type Task } from "./contracts";
import type { Config } from "./config";
import { applyConversation, applyTwilio, correlate, micros, type Providers } from "./providers";
import type { Store } from "./store";

// Provider polling is 15 seconds while active, 60 seconds for delayed final
// analysis/prices, and 1 hour after a day. No polling path ever redials.
export class CallEngine {
  constructor(readonly store: Store, readonly providers: Providers, readonly config: Config, private now: () => number = Date.now) {}
  async start(raw: unknown) {
    const input = startSchema.parse(raw);
    const requestHash = await digest(input.request_id);
    const hash = await digest(canonical(input));
    const existing = this.store.byRequest(requestHash);
    if (existing === "expired") throw new CallError("REQUEST_EXPIRED", "This request has already been used and its content expired. It will never be redialed.");
    if (existing) {
      if (existing.expires <= this.now()) throw new CallError("REQUEST_EXPIRED", "This request's call content has expired. It will never be redialed.");
      if (existing.hash !== hash) throw new CallError("IDEMPOTENCY_CONFLICT", "request_id was already used with different call instructions.");
      return this.view(existing);
    }
    const to = input.recipient === "self" ? this.config.selfNumber : input.recipient;
    if (this.config.testOnly && to !== this.config.selfNumber) throw new CallError("TEST_DESTINATION_ONLY", "Only the configured test number is enabled until voicemail acceptance is confirmed.");
    const duration = input.max_duration_seconds ?? (input.task_type === "reminder" ? 180 : 900);
    if (input.task_type === "reminder" && duration > 180) throw new CallError("DURATION_LIMIT", "Reminder calls are limited to three minutes.");
    if (this.store.active()) throw new CallError("CALL_IN_PROGRESS", "Another call is active or its dispatch is unresolved. Inspect that call before starting another.");
    const quote = await this.providers.preflight(to, duration, this.now());
    // Recheck synchronously after all network awaits: another start may have won.
    const raced = this.store.byRequest(requestHash);
    if (raced) {
      if (raced !== "expired" && raced.expires <= this.now()) throw new CallError("REQUEST_EXPIRED", "This request's call content has expired. It will never be redialed.");
      if (raced === "expired" || raced.hash !== hash) throw new CallError("IDEMPOTENCY_CONFLICT", "request_id changed or expired while validating setup.");
      return this.view(raced);
    }
    if (this.store.active()) throw new CallError("CALL_IN_PROGRESS", "Another call was accepted while setup was being checked.");
    const now = this.now();
    if (now - quote.checkedAt > 60_000) throw new CallError("PRICING_EXPIRED", "The preflight quote expired. Retry with the same request_id.");
    const month = monthAt(now);
    if (this.store.used(month) + quote.reservationMicros + micros(this.config.budget.fixedMonthlyUsd) > micros(this.config.budget.monthlyUsd)) throw new CallError("BUDGET_EXHAUSTED", "The monthly budget cannot cover this call's maximum allowance, existing charges and outstanding reservations.");
    const task: Task = { id: crypto.randomUUID(), requestId: requestHash, hash, input, to, duration, created: now, expires: now + RETENTION, month, telephone: "pending", outcome: "pending", cancelRequested: false, nextCheck: now, attempts: 0, reservationMicros: quote.reservationMicros };
    this.store.put(task);
    return this.view(task);
  }
  require(id: string) {
    const t = this.store.get(id);
    if (!t || t.expires <= this.now()) throw new CallError("CALL_NOT_FOUND", "Call not found or its 30-day retention period has ended.", false, 404);
    return t;
  }
  async tick() {
    const now = this.now();
    this.store.purge(now);
    for (const snapshot of this.store.due(now)) {
      if (snapshot.expires <= now) continue;
      if (snapshot.telephone === "pending") await this.dispatch(snapshot.id);
      else await this.reconcile(snapshot.id);
    }
    this.store.purge(now);
  }
  private async dispatch(id: string) {
    const task = this.require(id);
    if (task.telephone !== "pending") return;
    if (this.now() - task.created > 60_000) {
      task.telephone = "not_dispatched"; task.outcome = "failed";
      task.twilioCostMicros = 0; task.elevenCostMicros = 0; task.nextCheck = task.expires;
      task.lastError = { code: "DISPATCH_EXPIRED", message: "Dispatch did not begin within the 60-second quote window. No call was placed.", retryable: false };
      this.store.put(task); return;
    }
    task.telephone = "dispatching";
    task.dispatchedAt = this.now();
    task.deadline = task.dispatchedAt + 60_000 + task.duration * 1000;
    task.nextCheck = this.now() + 15_000;
    // The durable write precedes the one and only outbound request.
    this.store.put(task);
    try {
      const result = await this.providers.dispatch(task);
      const current = this.require(id); // callbacks/cancellation may have won during await
      if (result.conversation_id) {
        if (current.conversationId && current.conversationId !== result.conversation_id) throw new CallError("IDENTITY_MISMATCH", "Dispatch and callback conversation identities disagree.");
        current.conversationId = result.conversation_id;
      }
      if (result.callSid) {
        if (current.callSid && current.callSid !== result.callSid) throw new CallError("IDENTITY_MISMATCH", "Dispatch and callback call identities disagree.");
        current.callSid = result.callSid;
      }
      if (!terminal.has(current.telephone) && ["dispatching", "dispatch_unknown"].includes(current.telephone)) {
        // Even success:false may contain a call ID. Reconcile before releasing a slot.
        current.telephone = current.callSid ? "queued" : "dispatch_unknown";
      }
      if (!result.success) current.lastError = { code: "DISPATCH_REJECTED", message: "Provider did not confirm successful initiation. Reconciliation is required; no redial.", retryable: false };
      current.nextCheck = this.now();
      this.store.put(current);
    } catch (error) {
      const current = this.require(id);
      if (!terminal.has(current.telephone) && !current.callSid) current.telephone = "dispatch_unknown";
      current.lastError = publicError(error);
      current.nextCheck = this.now() + 15_000;
      this.store.put(current);
    }
  }
  async reconcile(id: string) {
    let task = this.require(id);
    if (task.telephone === "pending" || task.telephone === "not_dispatched") return;
    // A restart after the dispatch marker never sends a second outbound request.
    if (task.telephone === "dispatching") task.telephone = "dispatch_unknown";
    task.attempts++;
    task.nextCheck = this.now() + 15_000;
    this.store.put(task);
    try {
      if (!task.callSid) {
        const observation = this.store.nextObservation();
        const conversation = task.conversationId ? await this.providers.conversation(task.conversationId) : await this.providers.findConversation(task);
        task = this.require(id);
        if (conversation) {
          correlate(task, conversation, this.config);
          applyConversation(task, conversation, observation);
          this.store.put(task);
        }
      }
      if (task.callSid) {
        let observation = this.store.nextObservation();
        let call = await this.providers.call(task);
        task = this.require(id);
        applyTwilio(task, call, observation);
        this.store.put(task);
        if (!terminal.has(task.telephone) && (task.cancelRequested || (task.deadline !== undefined && this.now() >= task.deadline))) {
          // Cancel intent survives provider errors and object restarts.
          task.cancelRequested = true;
          this.store.put(task);
          await this.providers.terminate(task, call.status);
          observation = this.store.nextObservation();
          call = await this.providers.call(task);
          task = this.require(id);
          applyTwilio(task, call, observation);
          this.store.put(task);
          if (!terminal.has(task.telephone)) throw new CallError("TERMINATION_UNCONFIRMED", "Termination was requested but the provider still reports an active call.", true, 502);
        }
      }
      // Fetch analysis only after a known Twilio call has had its cancellation
      // and deadline enforced. An ElevenLabs outage must not block hangup.
      if (terminal.has(task.telephone)) {
        const observation = this.store.nextObservation();
        const conversation = task.conversationId ? await this.providers.conversation(task.conversationId) : await this.providers.findConversation(task);
        task = this.require(id);
        if (conversation) { correlate(task, conversation, this.config); applyConversation(task, conversation, observation); this.store.put(task); }
      }
      task = this.mergeLocal(task);
      if (task.telephone === "dispatch_unknown") task.lastError = { code: "DISPATCH_UNKNOWN", message: "Provider identity is still unresolved. No redial; capacity and budget remain reserved.", retryable: false };
      else delete task.lastError;
    } catch (error) {
      task = this.require(id);
      task.lastError = publicError(error);
    }
    const elapsed = this.now() - task.created;
    const complete = costsSettled(task) && task.transcript !== undefined;
    task.nextCheck = complete ? task.expires : this.now() + (!terminal.has(task.telephone) ? 15_000 : elapsed > DAY ? 3_600_000 : 60_000);
    if (!terminal.has(task.telephone) && task.deadline !== undefined && task.deadline > this.now()) task.nextCheck = Math.min(task.nextCheck, task.deadline);
    this.store.put(task);
  }
  private mergeLocal(task: Task) {
    // Only used after the final synchronous mutation; callback fields are already
    // merged by re-reading before each provider response is applied.
    const current = this.require(task.id);
    task.cancelRequested ||= current.cancelRequested;
    return task;
  }
  async cancel(id: string) {
    const task = this.require(id);
    if (task.telephone === "pending") {
      task.telephone = "not_dispatched"; task.outcome = "failed";
      task.twilioCostMicros = 0; task.elevenCostMicros = 0; task.nextCheck = task.expires;
    }
    task.cancelRequested = true;
    this.store.put(task);
    if (!terminal.has(task.telephone)) await this.reconcile(id);
    return this.view(this.require(id));
  }
  async callback(conversationId: string) {
    // Signed callback is a wake-up. Fetch the authoritative object to verify all
    // identities; don't let a stale or replayed payload overwrite current state.
    const observation = this.store.nextObservation();
    const c = await this.providers.conversation(conversationId);
    const id = c.user_id ?? c.conversation_initiation_client_data?.user_id;
    if (!id) throw new CallError("CALLBACK_UNCORRELATED", "Callback has no durable task correlation.", false, 409);
    const task = this.require(id);
    correlate(task, c, this.config);
    applyConversation(task, c, observation);
    task.nextCheck = this.now();
    this.store.put(task); // persisted before webhook acknowledgement
  }
  view(task: Task, includeTranscript = false, offset = 0, limit = 50): Record<string, unknown> {
    const turns = task.transcript;
    return {
      call_id: task.id, telephone_status: task.telephone, task_outcome: task.outcome,
      created_at: new Date(task.created).toISOString(), expires_at: new Date(task.expires).toISOString(),
      cancel_requested: task.cancelRequested, termination_confirmed: task.cancelRequested && terminal.has(task.telephone),
      summary: task.summary ?? null, confirmation_details: task.confirmation ?? null, unresolved_questions: task.unresolved ?? null,
      evidence: task.evidence ?? null, delivery_verified: false,
      provider: { conversation_id: task.conversationId ?? null, call_sid: task.callSid ?? null, configured_model: "gpt-4.1-mini", served_model: "not_reported" },
      cost: { reserved_usd: task.reservationMicros / 1e6, twilio_usd: task.twilioCostMicros === undefined ? null : task.twilioCostMicros / 1e6, elevenlabs_total_fiat_usd: task.elevenCostMicros === undefined ? null : task.elevenCostMicros / 1e6, status: costsSettled(task) ? "provider_reported" : "unsettled", note: "ElevenLabs total fiat is conservatively charged against the additional budget even when subscription credits cover it. Reported charges never decrease automatically; refunds require reconciliation." },
      transcript: includeTranscript && turns ? { turns: turns.slice(offset, offset + limit), total: turns.length, next_offset: offset + limit < turns.length ? offset + limit : null } : null,
      recording_url: task.hasAudio ? `${this.config.publicOrigin}/calls/${task.id}/recording` : null,
      error: task.lastError ?? null,
      poll_after_seconds: terminal.has(task.telephone) ? 60 : 15,
    };
  }
}
