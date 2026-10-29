import { z } from "zod";
import { dispatchBody } from "./agent";
import { readLimited } from "./auth";
import { secret } from "./config";
import { CallError, terminal, type ConferenceRole, type PhoneStatus, type Task } from "./contracts";
import { LiveProviders, ProviderHttpError, twilioCallSchema, type TwilioCall } from "./providers";

const cf = z.string().regex(/^CF[0-9a-fA-F]{32}$/);
const ca = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
const participantSchema = z.object({ account_sid: z.string(), conference_sid: cf, call_sid: ca, label: z.string() });
const roomSchema = z.object({ sid: cf, account_sid: z.string(), friendly_name: z.string(), status: z.enum(["init", "in-progress", "completed"]) });
export type Participant = z.infer<typeof participantSchema>;
export interface ConferenceProviders {
  create(task: Task, role: ConferenceRole): Promise<{ callSid: string; conferenceSid?: string }>;
  observe(task: Task, role: ConferenceRole, sid: string): Promise<TwilioCall>;
  finish(task: Task, role: ConferenceRole, status: PhoneStatus): Promise<void>;
  close(task: Task): Promise<void>;
  register(task: Task): Promise<string>;
}
export const roomName = (task: Task) => `phone-${task.id}`;
export const conferenceUrl = (origin: string, op: string, taskId: string, role?: ConferenceRole) => {
  const url = new URL("/webhooks/twilio/inbound", origin);
  url.searchParams.set("op", op); url.searchParams.set("call_id", taskId);
  if (role) url.searchParams.set("role", role);
  return url.toString();
};
export const assistantDestination = (task: Task, applicationSid: string) => `app:${applicationSid}?call_id=${task.id}`;
export const conferenceTwiml = (task: Task) => `<Dial><Conference beep="onEnter" startConferenceOnEnter="true" endConferenceOnExit="false" maxParticipants="3" record="do-not-record" waitUrl="">${roomName(task)}</Conference></Dial>`;

export class LiveConferenceProviders extends LiveProviders implements ConferenceProviders {
  private accountPath() { return `/2010-04-01/Accounts/${this.c.twilioAccountSid}`; }
  private destination(task: Task, role: ConferenceRole) {
    if (role === "business") return task.to;
    if (role === "owner") return this.c.selfNumber;
    if (!this.c.twilioApplicationSid) throw new CallError("SETUP_REQUIRED", "Conference TwiML application is not configured.", false, 503);
    return assistantDestination(task, this.c.twilioApplicationSid);
  }
  async create(task: Task, role: ConferenceRole) {
    const body = new URLSearchParams({ From: this.c.fromNumber, To: this.destination(task, role), Timeout: "60", Record: "false", StatusCallback: conferenceUrl(this.c.publicOrigin, "status", task.id, role), StatusCallbackMethod: "POST" });
    for (const event of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", event);
    // Each leg has the task's remaining time, in addition to the durable watchdog.
    body.set("TimeLimit", String(Math.max(1, Math.ceil(((task.deadline ?? task.created + task.duration * 1000) - Date.now()) / 1000))));
    if (role === "owner") {
      body.set("Url", conferenceUrl(this.c.publicOrigin, "owner-answer", task.id)); body.set("Method", "POST");
      const call = await this.twilio(`${this.accountPath()}/Calls.json`, twilioCallSchema, body);
      this.assertCall(task, role, call.sid, call);
      return { callSid: call.sid };
    }
    body.set("Label", role); body.set("Beep", "false"); body.set("WaitUrl", ""); body.set("MaxParticipants", "3");
    body.set("StartConferenceOnEnter", "true"); body.set("EndConferenceOnExit", role === "assistant" ? "true" : "false");
    body.set("ConferenceRecord", "do-not-record");
    const participant = await this.twilio(`${this.accountPath()}/Conferences/${task.conference?.sid ?? roomName(task)}/Participants.json`, participantSchema, body);
    if (participant.account_sid !== this.c.twilioAccountSid || participant.label !== role || (task.conference?.sid && task.conference.sid !== participant.conference_sid)) throw new CallError("IDENTITY_MISMATCH", "Conference participant identity does not match this task.", false, 502);
    return { callSid: participant.call_sid, conferenceSid: participant.conference_sid };
  }
  private assertCall(task: Task, role: ConferenceRole, sid: string, call: TwilioCall) {
    if (call.sid !== sid || call.account_sid !== this.c.twilioAccountSid || call.from !== this.c.fromNumber || call.to !== this.destination(task, role)) throw new CallError("IDENTITY_MISMATCH", "Conference call identity, source or destination does not match this task.", false, 502);
  }
  async observe(task: Task, role: ConferenceRole, sid: string) {
    const call = await this.twilio(`${this.accountPath()}/Calls/${sid}.json`, twilioCallSchema);
    this.assertCall(task, role, sid, call);
    return call;
  }
  async finish(task: Task, role: ConferenceRole, status: PhoneStatus) {
    const sid = task.conference?.legs[role].sid;
    if (!sid) throw new CallError("CALL_ID_UNKNOWN", "Conference participant call identity is unknown.", false, 409);
    if (terminal.has(status)) return;
    const call = await this.twilio(`${this.accountPath()}/Calls/${sid}.json`, twilioCallSchema, new URLSearchParams({ Status: status === "queued" || status === "ringing" ? "canceled" : "completed" }));
    this.assertCall(task, role, sid, call);
  }
  async close(task: Task) {
    if (!task.conference?.sid) return;
    try {
      const room = await this.twilio(`${this.accountPath()}/Conferences/${task.conference.sid}.json`, roomSchema, new URLSearchParams({ Status: "completed" }));
      if (room.sid !== task.conference.sid || room.account_sid !== this.c.twilioAccountSid || room.friendly_name !== roomName(task) || room.status !== "completed") throw new CallError("TERMINATION_UNCONFIRMED", "Conference termination is not confirmed.", true, 502);
    } catch (error) {
      // A 404 is not evidence that all independently billed calls have ended.
      if (!(error instanceof ProviderHttpError && error.httpStatus === 404)) throw error;
    }
  }
  async register(task: Task) {
    const response = await this.request("https://api.elevenlabs.io/v1/convai/twilio/register-call", { method: "POST", headers: { "xi-api-key": secret(this.env, "ELEVENLABS_API_KEY"), "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: this.c.elevenAgentId, from_number: this.c.fromNumber, to_number: task.to, direction: "outbound", conversation_initiation_client_data: dispatchBody(task, this.c).conversation_initiation_client_data }) });
    const twiml = await readLimited(response, 65536);
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<Response[\s>]/.test(twiml) || !twiml.includes("<Connect>") || !twiml.includes("<Stream ")) throw new CallError("PROVIDER_SCHEMA", "Call registration did not return connection TwiML.", false, 502);
    return twiml;
  }
}
