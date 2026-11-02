import { equal } from "./auth";
import type { Config } from "./config";
import { CallError, DAY, publicError, terminal, type ConferenceLeg, type ConferenceRole, type ConferenceState, type Task } from "./contracts";
import { conferenceTwiml, conferenceUrl, type ConferenceProviders } from "./conference-provider";
import { applyConversation, micros, ProviderHttpError, type Conversation, type Providers, type TwilioCall } from "./providers";
import type { Store } from "./store";
import { dispatchBody } from "./agent";

const roles: ConferenceRole[] = ["business", "assistant", "owner"];
const idleLeg = (): ConferenceLeg => ({ status: "not_started" });
const ended = (leg: ConferenceLeg) => leg.status === "not_started" || terminal.has(leg.status);
// Owner invitations: at most three dials to selfNumber per call, never two at once.
// A missed attempt (no answer, busy, failed, machine, or no 1 within the window)
// is retried about 10 seconds after it is observed to have ended.
export const OWNER_MAX_ATTEMPTS = 3;
export const OWNER_RETRY_DELAY_MS = 10_000;
export const OWNER_PRESS_SECONDS = 30;
const hangup = "<Response><Hangup/></Response>";
const machine = (answeredBy?: string) => answeredBy === "fax" || answeredBy?.startsWith("machine_") === true;
// Derived from durable state, so a restart or replay cannot reset the count.
export const ownerAttempts = (c: ConferenceState) => [...(c.ownerHistory ?? []), ...(c.legs.owner.status === "not_started" ? [] : [c.legs.owner])];
export const newConference = (assistantTransport: "app" | "sip" = "app") => ({ token: crypto.randomUUID(), assistantTransport, closed: false, closing: false, ownerAccepted: false, registration: "not_started" as const, legs: { business: idleLeg(), assistant: idleLeg(), owner: idleLeg() } });

export class ConferenceController {
  constructor(private store: Store, private transport: ConferenceProviders, private providers: Providers, private config: Config, private now: () => number) {}
  private require(id: string) {
    const task = this.store.get(id);
    if (!task || task.expires <= this.now()) throw new CallError("CALL_NOT_FOUND", "Call not found or expired.", false, 404);
    if (!task.conference) throw new CallError("CONFERENCE_DISABLED", "Owner joining was not enabled for this call.", false, 409);
    return task as Task & { conference: NonNullable<Task["conference"]> };
  }
  authorize(id: string, authorization: string | null) {
    const task = this.require(id);
    if (!authorization || !equal(authorization, `Bearer ${task.conference.token}`)) throw new CallError("UNAUTHENTICATED", "Invalid call-scoped tool authorization.", false, 401);
  }
  private open(id: string) {
    const task = this.require(id);
    if (task.conference.closed || task.conference.closing || task.cancelRequested || (task.deadline !== undefined && this.now() >= task.deadline)) throw new CallError("CALL_ENDED", "The conference has ended or is closing.", false, 409);
    if ([task.conference.legs.business, task.conference.legs.assistant, ...(task.conference.assistantApp ? [task.conference.assistantApp] : [])].some(leg => leg.status !== "not_started" && ended(leg))) throw new CallError("CALL_ENDED", "The recipient or assistant has disconnected.", false, 409);
    return task;
  }
  // An ended owner invitation keeps its own identity; late observations update only that attempt.
  private leg(task: Task & { conference: ConferenceState }, role: ConferenceRole | "assistantApp", sid: string) {
    if (role === "assistantApp") {
      if (!task.conference.assistantApp) throw new CallError("CALL_ID_UNKNOWN", "Assistant App call identity is unknown.", false, 409);
      return task.conference.assistantApp;
    }
    if (role === "owner" && task.conference.legs.owner.sid !== sid) {
      const earlier = task.conference.ownerHistory?.find(leg => leg.sid === sid);
      if (earlier) return earlier;
    }
    return task.conference.legs[role];
  }
  private earlier(id: string, sid: string) { return this.require(id).conference.ownerHistory?.some(leg => leg.sid === sid) ?? false; }
  private bind(id: string, role: ConferenceRole, sid: string, conferenceSid?: string) {
    const task = this.require(id), leg = task.conference.legs[role];
    if (leg.status === "not_started") throw new CallError("UNEXPECTED_PARTICIPANT", "This participant was not requested.", false, 409);
    if ((leg.sid && leg.sid !== sid) || (conferenceSid && task.conference.sid && task.conference.sid !== conferenceSid)) throw new CallError("IDENTITY_MISMATCH", "Conflicting conference or participant identity.", false, 502);
    if (leg.status === "not_dispatched" && !leg.sid) {
      // Authoritative provider evidence overrides an earlier rejection. Reopen
      // cleanup without creating any missing participant or repeating a dial.
      leg.status = "queued"; task.conference.closed = false; task.conference.closing = true;
      delete leg.costMicros;
    }
    leg.sid = sid;
    if (conferenceSid) task.conference.sid = conferenceSid;
    if (["dispatching", "dispatch_unknown"].includes(leg.status)) leg.status = "queued";
    if (role === "business") task.callSid = sid;
    task.nextCheck = this.now(); this.store.put(task);
  }
  private async create(id: string, role: ConferenceRole) {
    // Existing and ended legs still need reconciliation. Do not make the
    // new-dial admission check prevent their termination or status collection.
    if (this.require(id).conference.legs[role].status !== "not_started") return;
    const task = this.open(id), leg = task.conference.legs[role];
    if (role === "owner" && ownerAttempts(task.conference).length >= OWNER_MAX_ATTEMPTS) throw new CallError("OWNER_ATTEMPTS_USED", "Every owner invitation for this call has been used.", false, 409);
    // Persist before dialing; every other event sees the attempt and cannot repeat it.
    leg.status = "dispatching"; task.nextCheck = this.now() + 15_000; this.store.put(task);
    try {
      const result = await this.transport.create(task, role);
      this.bind(id, role, result.callSid, result.conferenceSid);
    } catch (error) {
      const current = this.require(id), currentLeg = current.conference.legs[role];
      if (!currentLeg.sid) currentLeg.status = error instanceof ProviderHttpError && [401, 403].includes(error.httpStatus) ? "not_dispatched" : "dispatch_unknown";
      if (role === "business") current.telephone = currentLeg.status as Task["telephone"];
      current.lastError = publicError(error); this.store.put(current);
    }
  }
  private applyCall(id: string, role: ConferenceRole | "assistantApp", call: TwilioCall, observation: number) {
    const task = this.require(id), leg = this.leg(task, role, call.sid);
    if (leg.sid !== call.sid) throw new CallError("IDENTITY_MISMATCH", "Observation belongs to another participant.", false, 502);
    if (leg.observation !== undefined && observation <= leg.observation) return;
    leg.observation = observation;
    if (!terminal.has(leg.status)) leg.status = call.status;
    if (call.price !== null) {
      if (call.price_unit !== "USD" || !/^-?\d+(\.\d+)?$/.test(call.price)) throw new CallError("COST_UNKNOWN", "Conference participant price is not a USD decimal.", false, 502);
      leg.costMicros = Math.max(leg.costMicros ?? 0, micros(Math.abs(Number(call.price))));
    }
    if (role === "business") task.telephone = leg.status as Task["telephone"];
    this.store.put(task);
  }
  private async refresh(id: string, role: ConferenceRole) {
    const task = this.require(id), sid = task.conference.legs[role].sid;
    if (!sid) return;
    const observation = this.store.nextObservation();
    const call = await this.transport.observe(task, role, sid);
    this.applyCall(id, role, call, observation);
  }
  private async refreshApp(id: string) {
    const task = this.require(id), sid = task.conference.assistantApp?.sid;
    if (!sid) return;
    const observation = this.store.nextObservation();
    this.applyCall(id, "assistantApp", await this.transport.observeApp(task, sid), observation);
  }
  // Prices arrive after a call ends, so observe ended invitations until each has one.
  private async refreshEarlier(id: string) {
    const task = this.require(id);
    for (const leg of task.conference.ownerHistory ?? []) {
      if (!leg.sid || leg.costMicros !== undefined) continue;
      const observation = this.store.nextObservation();
      this.applyCall(id, "owner", await this.transport.observe(task, "owner", leg.sid), observation);
    }
  }
  async status(id: string, role: ConferenceRole, sid: string) {
    const task = this.require(id);
    const observation = this.store.nextObservation();
    // A signed status callback supplies a candidate SID. Read the provider object
    // and validate its account and destination before correlating it to this task.
    const call = await this.transport.observe(task, role, sid);
    // Re-read after the request: a retry may have replaced the current invitation.
    // A callback for an ended invitation must never bind to the new one.
    if (!(role === "owner" && this.earlier(id, sid))) this.bind(id, role, sid);
    this.applyCall(id, role, call, observation);
    const current = this.require(id); current.nextCheck = this.now(); this.store.put(current);
  }
  observeConversation(id: string, conversation: Conversation, observation: number) {
    const task = this.require(id), phone = conversation.metadata.phone_call;
    const user = conversation.user_id ?? conversation.conversation_initiation_client_data?.user_id;
    if (user !== task.id || conversation.agent_id !== this.config.elevenAgentId || (task.conversationId && task.conversationId !== conversation.conversation_id)) throw new CallError("IDENTITY_MISMATCH", "Conversation does not belong to this conference.", false, 502);
    if (task.conference.assistantTransport === "sip") {
      if (!phone || phone.type !== "sip_trunking" || phone.call_sid !== task.conference.legs.assistant.sid || phone.phone_number_id !== this.config.conferenceSip?.phoneId) throw new CallError("IDENTITY_MISMATCH", "Conversation telephone metadata does not match the assistant SIP connection.", false, 502);
    } else if (phone && (phone.type !== "twilio" || phone.call_sid !== task.conference.assistantApp?.sid || phone.agent_number !== this.config.fromNumber || phone.external_number !== task.to)) throw new CallError("IDENTITY_MISMATCH", "Conversation telephone metadata does not match the assistant App connection.", false, 502);
    applyConversation(task, conversation, observation, false);
    task.nextCheck = this.now(); this.store.put(task);
  }
  async sip(sid: string, conversationId: string) {
    const resolved = await this.transport.resolveSip(sid);
    let task = this.open(resolved.taskId);
    if (task.conference.assistantTransport !== "sip" || resolved.call.sid !== sid || (task.conversationId && task.conversationId !== conversationId)) throw new CallError("IDENTITY_MISMATCH", "SIP initiation does not match this conference.", false, 502);
    const observation = this.store.nextObservation();
    this.bind(task.id, "assistant", sid);
    this.applyCall(task.id, "assistant", resolved.call, observation);
    task = this.open(task.id);
    task.conversationId = conversationId; task.conference.registration = "done"; task.nextCheck = this.now();
    this.store.put(task);
    const data = dispatchBody(task, this.config).conversation_initiation_client_data;
    // ElevenLabs accepts 60 to 7200 seconds. Twilio and the watchdog still enforce
    // the requested deadline, including a remaining budget shorter than 60 seconds.
    const remaining = Math.ceil(((task.deadline ?? task.created + task.duration * 1000) - this.now()) / 1000);
    data.conversation_config_override.conversation.max_duration_seconds = Math.max(60, Math.min(7200, remaining, task.duration));
    return { type: "conversation_initiation_client_data" as const, ...data };
  }
  async assistant(id: string, sid: string) {
    let task = this.open(id);
    if (task.conference.assistantTransport === "sip") throw new CallError("IDENTITY_MISMATCH", "A SIP conference cannot attach an App call.", false, 502);
    if (task.conference.legs.assistant.status === "not_started") throw new CallError("UNEXPECTED_PARTICIPANT", "The assistant participant was not requested.", false, 409);
    if (task.conference.assistantApp?.sid && task.conference.assistantApp.sid !== sid) throw new CallError("IDENTITY_MISMATCH", "Conflicting assistant App call identity.", false, 502);
    // The signed custom call_id correlates this receiving leg to the task.
    // Its authoritative object must name this account, caller and private App.
    const observation = this.store.nextObservation();
    const call = await this.transport.observeApp(task, sid);
    task = this.open(id);
    if (task.conference.assistantApp?.sid && task.conference.assistantApp.sid !== sid) throw new CallError("IDENTITY_MISMATCH", "Conflicting assistant App call identity.", false, 502);
    if (!task.conference.assistantApp) { task.conference.assistantApp = { sid, status: "queued" }; this.store.put(task); }
    this.applyCall(id, "assistantApp", call, observation);
    task = this.open(id);
    if (task.conference.registration === "done" && task.conference.twiml) return task.conference.twiml;
    if (task.conference.registration !== "not_started") throw new CallError("REGISTRATION_UNKNOWN", "An earlier assistant connection is unresolved. Do not create another.", false, 409);
    task.conference.registration = "dispatching"; this.store.put(task);
    try {
      const twiml = await this.transport.register(task);
      const current = this.require(id);
      current.conference.registration = "done"; current.conference.twiml = twiml; current.nextCheck = this.now(); this.store.put(current);
      // Cancellation may have arrived during registration. Never connect after it.
      this.open(id);
      return twiml;
    } catch (error) {
      const current = this.require(id);
      if (current.conference.registration !== "done") current.conference.registration = "unknown";
      current.lastError = publicError(error); this.store.put(current); throw error;
    }
  }
  async connectOwner(id: string) {
    let task = this.open(id);
    if (task.to === this.config.selfNumber) throw new CallError("OWNER_ALREADY_RECIPIENT", "The owner is already the original recipient.", false, 409);
    if (task.conference.legs.owner.status !== "not_started") return this.ownerView(task);
    await Promise.all([this.refresh(id, "business"), this.refresh(id, "assistant")]);
    task = this.open(id);
    if (task.conference.legs.business.status !== "in-progress" || task.conference.legs.assistant.status !== "in-progress") throw new CallError("CALL_NOT_CONNECTED", "Both the assistant and recipient must be connected before adding the owner.", false, 409);
    await this.create(id, "owner");
    return this.ownerView(this.require(id));
  }
  ownerView(task: Task) {
    const c = task.conference!, attempts = ownerAttempts(c);
    return {
      status: c.legs.owner.status, accepted: c.ownerAccepted, assistant_stays: true,
      attempts_used: attempts.length, max_attempts: OWNER_MAX_ATTEMPTS,
      next_attempt_at: c.ownerRetryAt === undefined ? null : new Date(c.ownerRetryAt).toISOString(),
      attempts: attempts.map(leg => ({ call_sid: leg.sid ?? null, telephone_status: leg.status, answered_by: leg.answeredBy ?? null, cost_usd: leg.costMicros === undefined ? null : leg.costMicros / 1e6 })),
      note: "The service rings the owner up to three times, one invitation at a time, about 10 seconds after each missed one, until the owner presses 1. A voicemail answer is hung up and counts as missed. Keep helping the representative while waiting. Ringing or an answered telephone call alone does not prove the owner joined. Calling connect_owner again only reports progress and never dials.",
    };
  }
  async ownerAnswer(id: string, sid: string, digits?: string, answeredBy?: string) {
    // An ended invitation never joins or accepts, even from a replayed or delayed webhook.
    if (this.earlier(id, sid)) return hangup;
    await this.status(id, "owner", sid);
    if (this.earlier(id, sid)) return hangup;
    const task = this.open(id);
    if (task.conference.legs.owner.status !== "in-progress") throw new CallError("CALL_NOT_CONNECTED", "Owner invitation is not connected.", false, 409);
    if (digits !== undefined) {
      if (digits !== "1") return hangup;
      task.conference.ownerAccepted = true; this.store.put(task);
      return `<Response>${conferenceTwiml(task)}</Response>`;
    }
    if (answeredBy !== undefined) { task.conference.legs.owner.answeredBy = answeredBy; this.store.put(task); }
    // Hang up on a machine before the prompt; the ended call then counts as missed.
    // A human, an unknown result or an absent result hears the prompt.
    if (machine(answeredBy)) return hangup;
    const action = conferenceUrl(this.config.publicOrigin, "owner-accept", task.id).replaceAll("&", "&amp;");
    return `<Response><Gather action="${action}" method="POST" numDigits="1" timeout="${OWNER_PRESS_SECONDS}"><Say>This is your automated assistant. Your participation is needed on a call. This call is recorded. Press 1 to join the call with your assistant.</Say></Gather><Hangup/></Response>`;
  }
  // Runs only after every leg was observed successfully in this tick.
  private async retryOwner(id: string) {
    const task = this.require(id), c = task.conference, owner = c.legs.owner;
    // A rejected dial (not_dispatched) stops invitations; an unresolved one waits for reconciliation.
    const missed = owner.status !== "not_started" && owner.status !== "not_dispatched" && terminal.has(owner.status) && !c.ownerAccepted;
    const live = !c.closing && !c.closed && !task.cancelRequested && !(task.deadline !== undefined && this.now() >= task.deadline)
      && c.legs.business.status === "in-progress" && c.legs.assistant.status === "in-progress";
    if (!missed || !live || ownerAttempts(c).length >= OWNER_MAX_ATTEMPTS) {
      if (c.ownerRetryAt !== undefined) { delete c.ownerRetryAt; this.store.put(task); }
      return;
    }
    if (c.ownerRetryAt === undefined) { c.ownerRetryAt = this.now() + OWNER_RETRY_DELAY_MS; this.store.put(task); return; }
    if (this.now() < c.ownerRetryAt) return;
    // Archive the ended invitation and mark the next one dispatching before any
    // await, so a concurrent callback, tick or tool request cannot start another.
    c.ownerHistory = [...(c.ownerHistory ?? []), owner]; c.legs.owner = idleLeg(); delete c.ownerRetryAt;
    this.store.put(task);
    await this.create(id, "owner");
  }
  async tick(id: string) {
    let task = this.require(id);
    try {
      if (!task.dispatchedAt && !task.cancelRequested) {
        task.dispatchedAt = this.now(); task.deadline = task.dispatchedAt + 60_000 + task.duration * 1000;
        task.telephone = "dispatching"; this.store.put(task);
      }
      if (task.cancelRequested || (task.deadline !== undefined && this.now() >= task.deadline)) {
        task.cancelRequested = true; task.conference.closing = true; this.store.put(task);
      }
      if (!task.conference.closing && !task.conference.closed) {
        await this.create(id, "assistant");
        task = this.require(id);
        if (task.conference.legs.assistant.sid && !ended(task.conference.legs.assistant)) await this.refresh(id, "assistant");
        await this.refreshApp(id);
        task = this.require(id);
        // Connect the internal AI participant before dialing an instant-answer
        // menu. The signed App callback schedules work after registration.
        if (task.conference.registration === "done" && task.conference.legs.assistant.status === "in-progress" && (task.conference.assistantTransport === "sip" || task.conference.assistantApp?.status === "in-progress")) await this.create(id, "business");
      }
      const observations = await Promise.allSettled([...roles.map(role => this.refresh(id, role)), this.refreshApp(id), this.refreshEarlier(id)]);
      const failure = observations.find(result => result.status === "rejected");
      task = this.require(id);
      if (["business", "assistant"].some(role => { const leg = task.conference.legs[role as ConferenceRole]; return leg.status !== "not_started" && ended(leg); }) || (task.conference.assistantApp && ended(task.conference.assistantApp))) task.conference.closing = true;
      this.store.put(task);
      if (task.conference.closing && !task.conference.closed) await this.close(id);
      if (failure?.status === "rejected") throw failure.reason;
      await this.retryOwner(id);
      task = this.require(id);
      if (task.conference.registration === "done") {
        const observation = this.store.nextObservation();
        const conversation = task.conversationId ? await this.providers.conversation(task.conversationId) : await this.providers.findConversation(task);
        if (conversation) this.observeConversation(id, conversation, observation);
      }
      task = this.require(id);
      const unresolved = roles.some(role => ["dispatching", "dispatch_unknown", "not_dispatched"].includes(task.conference.legs[role].status)) || ["dispatching", "unknown"].includes(task.conference.registration);
      if (!unresolved) { delete task.lastError; this.store.put(task); }
    } catch (error) {
      task = this.require(id); task.lastError = publicError(error); this.store.put(task);
    } finally {
      task = this.require(id);
      if (task.conference.closed) {
        const analyzed = task.conference.registration === "not_started" || ((task.elevenStatus === "done" || task.elevenStatus === "failed") && task.transcript !== undefined);
        task.nextCheck = analyzed ? task.expires : this.now() + (this.now() - task.created > DAY ? 3_600_000 : 60_000);
      } else {
        // Wake for a scheduled owner retry; a retry already due waits for the normal poll.
        const retry = task.conference.ownerRetryAt;
        task.nextCheck = retry !== undefined && retry > this.now() ? Math.min(retry, this.now() + 15_000) : this.now() + 15_000;
      }
      this.store.put(task);
    }
  }
  private async close(id: string) {
    let task = this.require(id);
    const attempts = await Promise.allSettled([...roles.map(async role => {
      const leg = this.require(id).conference.legs[role];
      if (leg.sid && !ended(leg)) {
        await this.transport.finish(this.require(id), role, leg.status as Task["telephone"]);
        await this.refresh(id, role);
      }
    }), (async () => {
      const app = this.require(id).conference.assistantApp;
      if (app?.sid && !ended(app)) {
        await this.transport.finishApp(this.require(id), app.status as Task["telephone"]);
        await this.refreshApp(id);
      }
    })()]);
    task = this.require(id);
    if (task.conference.sid) await this.transport.close(task);
    // Unknown attempted legs keep the watchdog alive; successful update responses
    // and an empty conference do not prove that a ringing outbound call stopped.
    task = this.require(id);
    if (roles.every(role => ended(task.conference.legs[role])) && (!task.conference.assistantApp || ended(task.conference.assistantApp))) {
      task.conference.closed = true;
      if (task.conference.legs.business.status === "not_started") task.telephone = "not_dispatched";
      if (task.outcome === "pending" && task.conference.registration === "not_started") task.outcome = "failed";
      delete task.conference.twiml;
      this.store.put(task);
    }
    const failed = attempts.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (!task.conference.closed) throw new CallError("TERMINATION_UNCONFIRMED", "Not every conference participant has confirmed termination.", true, 502);
  }
}
