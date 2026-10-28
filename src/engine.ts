import { CallError, DAY, RETENTION, publicError, startSchema, terminal, type Task } from "./contracts";
import type { Config } from "./config";
import { applyConversation, applyTwilio, correlate, type Providers } from "./providers";
import type { Store } from "./store";

// Provider polling is 15 seconds while active, 60 seconds for delayed final
// analysis, and 1 hour after a day. Polling observes existing calls.
export class CallEngine {
  constructor(readonly store: Store, readonly providers: Providers, readonly config: Config, private now: () => number = Date.now) {}
  async start(raw: unknown) {
    const input = startSchema.parse(raw);
    const to = input.recipient === "self" ? this.config.selfNumber : input.recipient;
    const duration = input.max_duration_seconds ?? (input.task_type === "reminder" ? 180 : 900);
    const now = this.now();
    const task: Task = { id: crypto.randomUUID(), input, to, duration, created: now, expires: now + RETENTION, telephone: "pending", outcome: "pending", cancelRequested: false, nextCheck: now, attempts: 0 };
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
    await Promise.all(this.store.due(now).map(async snapshot => {
      if (snapshot.expires <= now) return;
      if (snapshot.telephone === "pending") await this.dispatch(snapshot.id);
      else await this.reconcile(snapshot.id);
    }));
    this.store.purge(now);
  }
  private async dispatch(id: string) {
    const task = this.require(id);
    if (task.telephone !== "pending") return;
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
        // Even success:false may contain an existing call ID.
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
      if (task.telephone === "dispatch_unknown") task.lastError = { code: "DISPATCH_UNKNOWN", message: "Provider identity is still unresolved. Inspect this task for its result.", retryable: false };
      else delete task.lastError;
    } catch (error) {
      task = this.require(id);
      task.lastError = publicError(error);
    }
    const elapsed = this.now() - task.created;
    const complete = terminal.has(task.telephone) && (task.telephone === "not_dispatched" || ((task.elevenStatus === "done" || task.elevenStatus === "failed") && task.transcript !== undefined));
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
      provider: { conversation_id: task.conversationId ?? null, call_sid: task.callSid ?? null },
      cost: { twilio_usd: task.twilioCostMicros === undefined ? null : task.twilioCostMicros / 1e6, elevenlabs_total_fiat_usd: task.elevenCostMicros === undefined ? null : task.elevenCostMicros / 1e6, note: "Provider-reported amounts when available. These may be provisional and do not enforce a spending limit." },
      transcript: includeTranscript && turns ? { turns: turns.slice(offset, offset + limit), total: turns.length, next_offset: offset + limit < turns.length ? offset + limit : null } : null,
      recording_url: task.hasAudio ? `${this.config.publicOrigin}/calls/${task.id}/recording` : null,
      error: task.lastError ?? null,
      poll_after_seconds: terminal.has(task.telephone) ? 60 : 15,
    };
  }
}
