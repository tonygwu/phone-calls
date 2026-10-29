import { equal } from "./auth";
import type { Config } from "./config";
import { CallError, DAY, publicError, terminal, type ConferenceLeg, type ConferenceRole, type Task } from "./contracts";
import { conferenceTwiml, conferenceUrl, type ConferenceProviders } from "./conference-provider";
import { applyConversation, micros, ProviderHttpError, type Conversation, type Providers, type TwilioCall } from "./providers";
import type { Store } from "./store";

const roles: ConferenceRole[] = ["business", "assistant", "owner"];
const idleLeg = (): ConferenceLeg => ({ status: "not_started" });
const ended = (leg: ConferenceLeg) => leg.status === "not_started" || terminal.has(leg.status);
export const newConference = () => ({ token: crypto.randomUUID(), closed: false, closing: false, ownerAccepted: false, registration: "not_started" as const, legs: { business: idleLeg(), assistant: idleLeg(), owner: idleLeg() } });

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
    if ([task.conference.legs.business, task.conference.legs.assistant].some(leg => leg.status !== "not_started" && ended(leg))) throw new CallError("CALL_ENDED", "The recipient or assistant has disconnected.", false, 409);
    return task;
  }
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
  private applyCall(id: string, role: ConferenceRole, call: TwilioCall, observation: number) {
    const task = this.require(id), leg = task.conference.legs[role];
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
  async status(id: string, role: ConferenceRole, sid: string) {
    const task = this.require(id);
    const observation = this.store.nextObservation();
    // A signed status callback supplies a candidate SID. Read the provider object
    // and validate its account and destination before correlating it to this task.
    const call = await this.transport.observe(task, role, sid);
    this.bind(id, role, sid); this.applyCall(id, role, call, observation);
    const current = this.require(id); current.nextCheck = this.now(); this.store.put(current);
  }
  observeConversation(id: string, conversation: Conversation, observation: number) {
    const task = this.require(id), phone = conversation.metadata.phone_call;
    const user = conversation.user_id ?? conversation.conversation_initiation_client_data?.user_id;
    if (user !== task.id || conversation.agent_id !== this.config.elevenAgentId || (task.conversationId && task.conversationId !== conversation.conversation_id)) throw new CallError("IDENTITY_MISMATCH", "Conversation does not belong to this conference.", false, 502);
    if (phone && (phone.call_sid !== task.conference.legs.assistant.sid || phone.agent_number !== this.config.fromNumber || phone.external_number !== task.to)) throw new CallError("IDENTITY_MISMATCH", "Conversation telephone metadata does not match the assistant participant.", false, 502);
    applyConversation(task, conversation, observation, false);
    task.nextCheck = this.now(); this.store.put(task);
  }
  async assistant(id: string, sid: string) {
    let task = this.open(id);
    // The authoritative call readback validates the configured App destination;
    // the voice webhook need not contain an undocumented ApplicationSid field.
    await this.status(id, "assistant", sid);
    task = this.open(id);
    if (task.conference.registration === "done" && task.conference.twiml) return task.conference.twiml;
    if (task.conference.registration !== "not_started") throw new CallError("REGISTRATION_UNKNOWN", "An earlier assistant connection is unresolved. Do not create another.", false, 409);
    task.conference.registration = "dispatching"; this.store.put(task);
    try {
      const twiml = await this.transport.register(task);
      const current = this.require(id);
      current.conference.registration = "done"; current.conference.twiml = twiml; this.store.put(current);
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
    const c = task.conference!;
    return { status: c.legs.owner.status, accepted: c.ownerAccepted, assistant_stays: true, note: "Answer and press 1 to join. Ringing or an answered telephone call alone does not prove the owner joined. The invitation is attempted at most once." };
  }
  async ownerAnswer(id: string, sid: string, digits?: string) {
    await this.status(id, "owner", sid);
    const task = this.open(id);
    if (task.conference.legs.owner.status !== "in-progress") throw new CallError("CALL_NOT_CONNECTED", "Owner invitation is not connected.", false, 409);
    if (digits !== undefined) {
      if (digits !== "1") return "<Response><Hangup/></Response>";
      task.conference.ownerAccepted = true; this.store.put(task);
      return `<Response>${conferenceTwiml(task)}</Response>`;
    }
    const action = conferenceUrl(this.config.publicOrigin, "owner-accept", task.id).replaceAll("&", "&amp;");
    return `<Response><Gather action="${action}" method="POST" numDigits="1" timeout="10"><Say>This is your automated assistant. Your participation is needed on a call. This call is recorded. Press 1 to join the call with your assistant.</Say></Gather><Hangup/></Response>`;
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
        task = this.require(id);
        // Connect the internal AI participant before dialing an instant-answer
        // menu. The signed App callback schedules work after registration.
        if (task.conference.registration === "done" && task.conference.legs.assistant.status === "in-progress") await this.create(id, "business");
      }
      const observations = await Promise.allSettled(roles.map(role => this.refresh(id, role)));
      const failure = observations.find(result => result.status === "rejected");
      task = this.require(id);
      if (["business", "assistant"].some(role => { const leg = task.conference.legs[role as ConferenceRole]; return leg.status !== "not_started" && ended(leg); })) task.conference.closing = true;
      this.store.put(task);
      if (task.conference.closing && !task.conference.closed) await this.close(id);
      if (failure?.status === "rejected") throw failure.reason;
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
      } else task.nextCheck = this.now() + 15_000;
      this.store.put(task);
    }
  }
  private async close(id: string) {
    let task = this.require(id);
    const attempts = await Promise.allSettled(roles.map(async role => {
      const leg = this.require(id).conference.legs[role];
      if (leg.sid && !ended(leg)) {
        await this.transport.finish(this.require(id), role, leg.status as Task["telephone"]);
        await this.refresh(id, role);
      }
    }));
    task = this.require(id);
    if (task.conference.sid) await this.transport.close(task);
    // Unknown attempted legs keep the watchdog alive; successful update responses
    // and an empty conference do not prove that a ringing outbound call stopped.
    task = this.require(id);
    if (roles.every(role => ended(task.conference.legs[role]))) {
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
