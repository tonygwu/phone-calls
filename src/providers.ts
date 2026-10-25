import { z } from "zod";
import { CallError, terminal, type Task, type PhoneStatus, type TranscriptTurn } from "./contracts";
import { type Config, type Env, secret } from "./config";
import { agentDefinition, agentHash, dispatchBody } from "./agent";

const sid = z.string().regex(/^CA[0-9a-fA-F]{32}$/);
export const dispatchResponse = z.object({ success: z.boolean(), message: z.string(), conversation_id: z.string().nullable(), callSid: sid.nullable() });
const phoneStatus = z.enum(["queued", "ringing", "in-progress", "completed", "busy", "no-answer", "canceled", "failed"]);
const twilioCallSchema = z.object({ sid, account_sid: z.string(), from: z.string(), to: z.string(), status: phoneStatus, price: z.string().nullable(), price_unit: z.string().nullable(), start_time: z.string().nullable(), duration: z.string().nullable() });
const turnSchema = z.object({ role: z.enum(["user", "agent"]), message: z.string().nullable(), time_in_call_secs: z.number().nonnegative(), tool_calls: z.array(z.unknown()).nullish(), tool_results: z.array(z.unknown()).nullish() });
export const conversationSchema = z.object({
  agent_id: z.string(), conversation_id: z.string(), user_id: z.string().nullish(),
  status: z.enum(["initiated", "in-progress", "processing", "done", "failed"]), has_audio: z.boolean(),
  conversation_initiation_client_data: z.object({ user_id: z.string().nullish(), dynamic_variables: z.record(z.string(), z.unknown()).optional() }).optional(),
  transcript: z.array(turnSchema),
  metadata: z.object({ start_time_unix_secs: z.number().int(), call_duration_secs: z.number().nonnegative(), cost_fiat: z.number().nonnegative().nullable(), phone_call: z.object({ type: z.literal("twilio"), call_sid: sid, phone_number_id: z.string(), agent_number: z.string(), external_number: z.string(), direction: z.literal("outbound") }).nullish() }),
  analysis: z.object({ transcript_summary: z.string(), data_collection_results: z.record(z.string(), z.object({ value: z.unknown(), rationale: z.string() })).optional() }).nullish(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export type TwilioCall = z.infer<typeof twilioCallSchema>;
export type Quote = { reservationMicros: number; creditsAvailable: number; twilioBalanceUsd: number; twilioPerMinuteUsd: number; checkedAt: number; accountSid: string; agentId: string; model: string; voiceId: string };
export interface Providers {
  preflight(to: string, duration: number, now: number): Promise<Quote>;
  dispatch(task: Task): Promise<z.infer<typeof dispatchResponse>>;
  conversation(id: string): Promise<Conversation>;
  findConversation(task: Task): Promise<Conversation | null>;
  call(task: Task): Promise<TwilioCall>;
  terminate(task: Task, status: PhoneStatus): Promise<void>;
  audio(id: string): Promise<Response>;
}
export const micros = (usd: number) => Math.ceil(usd * 1_000_000);
const numeric = (value: string, label: string) => {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new CallError("PROVIDER_SCHEMA", `${label} is not a valid decimal.`, false, 502);
  return Number(value);
};
function assert(check: unknown, code: string, message: string): asserts check {
  if (!check) throw new CallError(code, message, false, 503);
}
// Check the full desired subset in addition to the approved readback hash.
export function assertSubset(actual: unknown, desired: unknown, path = "agent") {
  if (desired && typeof desired === "object" && !Array.isArray(desired)) {
    assert(actual && typeof actual === "object", "CONFIG_DRIFT", `${path} is absent.`);
    for (const [key, value] of Object.entries(desired)) assertSubset((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
  } else assert(JSON.stringify(actual) === JSON.stringify(desired), "CONFIG_DRIFT", `${path} differs from the required configuration.`);
}

export class LiveProviders implements Providers {
  constructor(private env: Env, private c: Config, private fetcher: typeof fetch = fetch) {}
  private async request<S extends z.ZodType>(url: string, init: RequestInit, schema: S): Promise<z.output<S>>;
  private async request(url: string, init: RequestInit): Promise<Response>;
  private async request(url: string, init: RequestInit, schema?: z.ZodType): Promise<unknown> {
    let res: Response;
    // Native Workers fetch must not receive this LiveProviders instance as its receiver.
    const fetcher = this.fetcher;
    try { res = await fetcher(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) }); }
    catch { throw new CallError("PROVIDER_UNCERTAIN", "Provider request timed out or transport failed. A dispatch must not be retried.", false, 502); }
    // Workers lacks redirect:"error". Never follow redirects with provider credentials.
    // A redirect after a dispatch is uncertain, so it must not release a retry.
    if (!res.ok) throw new CallError((res.status >= 300 && res.status < 400) || res.status >= 500 ? "PROVIDER_UNCERTAIN" : "PROVIDER_REJECTED", `Provider returned HTTP ${res.status}.`, false, 502);
    if (!schema) return res;
    try { return schema.parse(await res.json()); }
    catch { throw new CallError("PROVIDER_SCHEMA", "Provider response did not match the required schema. Inspect provider state before retrying.", false, 502); }
  }
  private eleven<S extends z.ZodType>(path: string, schema: S, body?: unknown) {
    return this.request(`https://api.elevenlabs.io${path}`, { method: body === undefined ? "GET" : "POST", headers: { "xi-api-key": secret(this.env, "ELEVENLABS_API_KEY"), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, schema);
  }
  private twilio<S extends z.ZodType>(path: string, schema: S, body?: URLSearchParams, pricing = false) {
    return this.request(`https://${pricing ? "pricing" : "api"}.twilio.com${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Basic ${btoa(`${this.c.twilioAccountSid}:${secret(this.env, "TWILIO_AUTH_TOKEN")}`)}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) }, ...(body ? { body: body.toString() } : {}) }, schema);
  }
  async preflight(to: string, duration: number, now: number): Promise<Quote> {
    const c = this.c;
    secret(this.env, "ELEVENLABS_WEBHOOK_SECRET");
    assert(Date.parse(c.budget.verifiedAt) <= now && Date.parse(c.budget.expiresAt) > now && Date.parse(c.budget.expiresAt) - Date.parse(c.budget.verifiedAt) <= 86_400_000, "PRICING_UNKNOWN", "The cost allowance needs a current verified quote with at most 24 hours validity.");
    const [agent, phone, account, number, subscription, balance, pricing] = await Promise.all([
      this.eleven(`/v1/convai/agents/${encodeURIComponent(c.elevenAgentId)}`, z.record(z.string(), z.unknown())),
      this.eleven(`/v1/convai/phone-numbers/${encodeURIComponent(c.elevenPhoneId)}`, z.object({ phone_number_id: z.string(), phone_number: z.string(), provider: z.literal("twilio"), assigned_agent: z.unknown() })),
      this.twilio(`/2010-04-01/Accounts/${c.twilioAccountSid}.json`, z.object({ sid: z.string(), status: z.literal("active"), type: z.string() })),
      this.twilio(`/2010-04-01/Accounts/${c.twilioAccountSid}/IncomingPhoneNumbers/${c.twilioNumberSid}.json`, z.object({ sid: z.string(), account_sid: z.string(), phone_number: z.string(), voice_url: z.string(), voice_method: z.string(), voice_application_sid: z.string().nullable(), voice_fallback_url: z.string().nullable(), trunk_sid: z.string().nullable(), sms_url: z.string().nullable(), sms_application_sid: z.string().nullable(), sms_fallback_url: z.string().nullable() })),
      this.eleven("/v1/user/subscription", z.object({ status: z.string(), tier: z.string(), character_count: z.number().nonnegative(), character_limit: z.number().nonnegative() })),
      this.twilio(`/2010-04-01/Accounts/${c.twilioAccountSid}/Balance.json`, z.object({ account_sid: z.string(), currency: z.literal("USD"), balance: z.string() })),
      this.twilio(`/v2/Voice/Numbers/${encodeURIComponent(to)}?OriginationNumber=${encodeURIComponent(c.fromNumber)}`, z.object({
        destination_number: z.string(), origination_number: z.string(), country: z.string(), iso_country: z.literal("US"), price_unit: z.literal("USD"),
        // The provider filters by the exact caller. Multiple remaining prices are
        // ambiguous: block rather than guess a prefix or choose the cheapest rate.
        outbound_call_prices: z.array(z.object({ current_price: z.string(), origination_prefixes: z.array(z.string().min(1)).min(1) })).length(1),
      }), undefined, true),
    ]);
    assert(account.sid === c.twilioAccountSid && account.type === "Full", "ACCOUNT_NOT_READY", "Twilio must be the selected active paid account. Trial routing has not been accepted for this evaluation.");
    assert(number.sid === c.twilioNumberSid && number.account_sid === c.twilioAccountSid && number.phone_number === c.fromNumber, "IDENTITY_MISMATCH", "Twilio number does not match the configured account and caller ID.");
    assert(number.voice_url === `${c.publicOrigin}/webhooks/twilio/inbound` && number.voice_method === "POST" && !number.voice_application_sid && !number.voice_fallback_url && !number.trunk_sid && !number.sms_url && !number.sms_application_sid && !number.sms_fallback_url, "ROUTING_UNSAFE", "Inbound voice must use the rejecting webhook; SMS and all fallback routes must be empty.");
    assert(phone.phone_number_id === c.elevenPhoneId && phone.phone_number === c.fromNumber && phone.assigned_agent === null, "ROUTING_UNSAFE", "ElevenLabs number must match the caller ID and have no inbound assigned agent.");
    assert(agent.agent_id === c.elevenAgentId, "IDENTITY_MISMATCH", "ElevenLabs returned a different agent.");
    const desired = agentDefinition(c.voiceId);
    assertSubset(agent.conversation_config, desired.conversation_config);
    assertSubset(agent.platform_settings, desired.platform_settings);
    assert(await agentHash(agent) === c.agentConfigHash, "CONFIG_DRIFT", "Agent configuration differs from its approved readback hash.");
    assert(subscription.status === "active" && !["free", "trial"].includes(subscription.tier), "ACCOUNT_NOT_READY", "An active paid ElevenLabs subscription is required; Agents pricing must be verified in the quote.");
    const creditsAvailable = subscription.character_limit - subscription.character_count;
    const minutes = Math.ceil(duration / 60);
    assert(creditsAvailable >= minutes * c.budget.elevenCreditsPerMinute, "CREDITS_EXHAUSTED", "Insufficient included ElevenLabs credits for the maximum call duration. No automatic top-up is allowed.");
    assert(balance.account_sid === c.twilioAccountSid && pricing.destination_number === to && pricing.origination_number === c.fromNumber, "IDENTITY_MISMATCH", "Balance or destination pricing belongs to a different account, destination or caller number.");
    const twilioPerMinuteUsd = numeric(pricing.outbound_call_prices[0].current_price, "Twilio rate");
    assert(Number.isFinite(twilioPerMinuteUsd) && twilioPerMinuteUsd >= 0, "PRICING_UNKNOWN", "Twilio returned a non-finite or negative rate.");
    const reservationMicros = minutes * (micros(twilioPerMinuteUsd) + micros(c.budget.additionalPerMinuteUsd)) + micros(c.budget.additionalPerCallUsd);
    const twilioBalanceUsd = numeric(balance.balance, "Twilio balance");
    assert(twilioBalanceUsd >= minutes * twilioPerMinuteUsd, "FUNDING_REQUIRED", "Twilio balance cannot cover this call. No automatic top-up is allowed.");
    return { reservationMicros, creditsAvailable, twilioBalanceUsd, twilioPerMinuteUsd, checkedAt: now, accountSid: account.sid, agentId: c.elevenAgentId, model: "gpt-4.1-mini", voiceId: c.voiceId };
  }
  async dispatch(task: Task) {
    return await this.eleven("/v1/convai/twilio/outbound-call", dispatchResponse, dispatchBody(task, this.c)) as z.infer<typeof dispatchResponse>;
  }
  async conversation(id: string) {
    const result = await this.eleven(`/v1/convai/conversations/${encodeURIComponent(id)}`, conversationSchema) as Conversation;
    assert(result.conversation_id === id && result.agent_id === this.c.elevenAgentId, "IDENTITY_MISMATCH", "Conversation does not belong to this managed agent.");
    return result;
  }
  async findConversation(task: Task) {
    const query = new URLSearchParams({ agent_id: this.c.elevenAgentId, user_id: task.id, page_size: "100" });
    const list = await this.eleven(`/v1/convai/conversations?${query}`, z.object({ conversations: z.array(z.object({ conversation_id: z.string(), agent_id: z.string() })), has_more: z.boolean() }));
    assert(!list.has_more && list.conversations.length <= 1, "CORRELATION_AMBIGUOUS", "Conversation lookup returned multiple results or more pages. Manual reconciliation is required; no redial.");
    if (list.conversations.length === 0) return null;
    return this.conversation(list.conversations[0].conversation_id);
  }
  async call(task: Task) {
    assert(task.callSid, "CALL_ID_UNKNOWN", "Twilio call identity is not yet known. Reconciliation is required.");
    const c = await this.twilio(`/2010-04-01/Accounts/${this.c.twilioAccountSid}/Calls/${task.callSid}.json`, twilioCallSchema) as TwilioCall;
    assert(c.sid === task.callSid && c.account_sid === this.c.twilioAccountSid && c.from === this.c.fromNumber && c.to === task.to, "IDENTITY_MISMATCH", "Twilio call identity, caller ID, or destination does not match the durable task.");
    return c;
  }
  async terminate(task: Task, status: PhoneStatus) {
    assert(task.callSid, "CALL_ID_UNKNOWN", "Cannot terminate until the Twilio call ID is known.");
    if (terminal.has(status)) return;
    await this.twilio(`/2010-04-01/Accounts/${this.c.twilioAccountSid}/Calls/${task.callSid}.json`, twilioCallSchema, new URLSearchParams({ Status: status === "queued" || status === "ringing" ? "canceled" : "completed" }));
  }
  async audio(id: string) {
    return this.request(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(id)}/audio`, { headers: { "xi-api-key": secret(this.env, "ELEVENLABS_API_KEY") } }) as Promise<Response>;
  }
}

export function correlate(task: Task, c: Conversation, config: Config) {
  const correlation = c.user_id ?? c.conversation_initiation_client_data?.user_id;
  if (correlation !== task.id || c.agent_id !== config.elevenAgentId || (task.conversationId && c.conversation_id !== task.conversationId)) throw new CallError("IDENTITY_MISMATCH", "Conversation correlation does not match this task.", false, 502);
  const phone = c.metadata.phone_call;
  if (phone && (phone.agent_number !== config.fromNumber || phone.external_number !== task.to || phone.phone_number_id !== config.elevenPhoneId || (task.callSid && phone.call_sid !== task.callSid))) throw new CallError("IDENTITY_MISMATCH", "Conversation telephone metadata does not match this task.", false, 502);
}
export function applyConversation(task: Task, c: Conversation, observation: number) {
  if (task.elevenObservation !== undefined && observation <= task.elevenObservation) return;
  if ((task.elevenStatus === "done" || task.elevenStatus === "failed") && c.status !== "done" && c.status !== "failed") return;
  task.elevenObservation = observation;
  task.elevenStatus = c.status;
  task.conversationId = c.conversation_id;
  if (c.metadata.phone_call) task.callSid = c.metadata.phone_call.call_sid;
  task.providerStart = c.metadata.start_time_unix_secs * 1000;
  task.providerDuration = c.metadata.call_duration_secs;
  if (task.deadline) task.deadline = Math.min(task.deadline, task.providerStart + 60_000 + task.duration * 1000);
  if (c.metadata.cost_fiat !== null) {
    task.elevenCostMicros = Math.max(task.elevenCostMicros ?? 0, micros(c.metadata.cost_fiat));
    // A later terminal response without a price cannot finalize a prior estimate.
    if (c.status === "done" || c.status === "failed") task.elevenCostFinal = true;
  }
  if (c.status !== "done" && c.status !== "failed") return;
  task.transcript = c.transcript as TranscriptTurn[];
  task.hasAudio = c.has_audio;
  task.summary = c.analysis?.transcript_summary;
  task.outcome = "unknown";
  const data = c.analysis?.data_collection_results;
  const outcome = data?.outcome?.value;
  const allowed = ["completed", "partial", "failed", "needs_user_input", "unknown", "voicemail_attempted", "delivered_to_person"] as const;
  if (typeof outcome === "string" && allowed.includes(outcome as typeof allowed[number])) {
    // Provider analysis is reported as its own evidence, never as mailbox confirmation.
    task.outcome = outcome as typeof allowed[number];
    if (task.input.task_type === "reminder" && task.outcome === "completed") task.outcome = "unknown";
    task.evidence = "ElevenLabs post-call analysis; not independently confirmed by the recipient.";
  }
  task.confirmation = typeof data?.confirmation?.value === "string" ? data.confirmation.value : undefined;
  task.unresolved = typeof data?.unresolved?.value === "string" ? data.unresolved.value : undefined;
}
export function applyTwilio(task: Task, c: TwilioCall, observation: number) {
  if (task.twilioObservation !== undefined && observation <= task.twilioObservation) return;
  if (terminal.has(task.telephone) && !terminal.has(c.status)) return;
  task.twilioObservation = observation;
  // Terminal states cannot be regressed by an older provider snapshot.
  if (!terminal.has(task.telephone)) task.telephone = c.status;
  if (c.price !== null) {
    if (c.price_unit !== "USD") throw new CallError("COST_UNKNOWN", "Twilio returned a charge in an unexpected currency.");
    task.twilioCostMicros = Math.max(task.twilioCostMicros ?? 0, micros(Math.abs(numeric(c.price, "Twilio charge"))));
    if (terminal.has(c.status)) task.twilioCostFinal = true;
  }
  if (["busy", "no-answer", "failed"].includes(c.status) && task.outcome === "pending") task.outcome = "failed";
}
