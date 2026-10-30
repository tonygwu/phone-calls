import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export const usPhone = z.string().regex(/^\+1\d{10}$/).refine(value => {
  const phone = parsePhoneNumberFromString(value);
  return phone?.country === "US" && phone.isValid();
}, "Use a valid United States number in +1XXXXXXXXXX format. Canada and other +1 destinations are excluded.");

const text = (max: number) => z.string().trim().min(1).max(max);
export const startSchema = z.strictObject({
  request_id: text(128).regex(/^[a-zA-Z0-9._:-]+$/).optional().describe("Optional client label accepted for existing clients. It is ignored: every invocation starts a new call, including repeated labels."),
  task_type: z.enum(["reminder", "booking", "support", "general"]),
  recipient: z.union([z.literal("self"), usPhone]),
  owner_join: z.enum(["disabled", "when_needed", "when_live_agent"]).optional().describe("Enable a conference that keeps the assistant on the call. when_live_agent adds the owner after a live support representative answers; when_needed adds the owner if their involvement is required. Omit or use disabled for an ordinary call. Requires conference setup. The owner must press 1 to join."),
  objective: text(2000),
  context: text(12000).describe("Short factual notes for the call, including dates and timezone. Keep behavioral instructions in rules. These notes are background, not a script. Do not supply credentials, one-time codes, or unnecessary private information."),
  rules: z.array(text(500)).max(20).optional().describe("Optional short imperative rules to follow silently, never read aloud. Put lookup, ownership, completion and reviewer guardrails here, separate from facts. At most 20 rules of 500 characters each."),
  success_criteria: z.array(text(1000)).min(1).max(10),
  constraints: z.strictObject({
    permitted_commitments: z.array(text(1000)).max(20),
    acceptable_alternatives: z.array(text(1000)).max(20),
    information_may_disclose: z.array(text(1000)).max(20),
  }),
  voicemail: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("hang_up") }),
    z.strictObject({ action: z.literal("leave_message"), message: text(1500) }),
  ]),
  max_duration_seconds: z.number().int().positive().optional(),
});
export type StartInput = z.infer<typeof startSchema>;
export const callId = z.string().uuid();
export const getSchema = z.strictObject({ call_id: callId, include_transcript: z.boolean().default(false), transcript_offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) });
export const listSchema = z.strictObject({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) });
export const cancelSchema = z.strictObject({ call_id: callId });
export const resultSchema = z.object({ ok: z.boolean(), data: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional() });

export class CallError extends Error {
  constructor(public code: string, message: string, public retryable = false, public status = 400) { super(message); }
}
export function publicError(error: unknown) {
  if (error instanceof CallError) return { code: error.code, message: error.message, retryable: error.retryable };
  if (error instanceof z.ZodError) return { code: "INVALID_INPUT", message: error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "), retryable: false };
  // Provider bodies, request context and secret values must never escape in errors.
  return { code: "INTERNAL_ERROR", message: "The operation failed. Inspect sanitized service diagnostics before retrying. Never redial an uncertain call.", retryable: false };
}

export const DAY = 86_400_000;
export const RETENTION = 30 * DAY;
export const terminal = new Set(["completed", "busy", "no-answer", "canceled", "failed", "not_dispatched"]);
export type PhoneStatus = "pending" | "dispatching" | "dispatch_unknown" | "queued" | "ringing" | "in-progress" | "completed" | "busy" | "no-answer" | "canceled" | "failed" | "not_dispatched";
export type Outcome = "pending" | "unknown" | "voicemail_attempted" | "delivered_to_person" | "completed" | "partial" | "failed" | "needs_user_input";
export type TranscriptTurn = { role: "user" | "agent"; message: string | null; time_in_call_secs: number; tool_calls?: unknown[] | null; tool_results?: unknown[] | null };
export type ConferenceRole = "business" | "assistant" | "owner";
export type ConferenceLeg = { status: PhoneStatus | "not_started"; sid?: string; costMicros?: number; observation?: number };
export interface ConferenceState {
  token: string;
  sid?: string;
  closed: boolean;
  closing: boolean;
  ownerAccepted: boolean;
  registration: "not_started" | "dispatching" | "done" | "unknown";
  twiml?: string;
  legs: Record<ConferenceRole, ConferenceLeg>;
}
export const activeTask = (task: Task) => task.conference ? !task.conference.closed : !terminal.has(task.telephone);
export interface Task {
  id: string; input: StartInput; to: string;
  created: number; expires: number; duration: number;
  telephone: PhoneStatus; outcome: Outcome; cancelRequested: boolean;
  dispatchedAt?: number; deadline?: number; conversationId?: string; callSid?: string;
  nextCheck: number; attempts: number; lastError?: ReturnType<typeof publicError>;
  twilioCostMicros?: number; elevenCostMicros?: number;
  summary?: string; confirmation?: string; unresolved?: string;
  transcript?: TranscriptTurn[]; hasAudio?: boolean; evidence?: string;
  providerStart?: number; providerDuration?: number;
  elevenStatus?: "initiated" | "in-progress" | "processing" | "done" | "failed";
  elevenObservation?: number; twilioObservation?: number;
  conference?: ConferenceState;
}
export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
