import { vi } from "vitest";
import type { Config } from "../src/config";
import type { StartInput, Task } from "../src/contracts";
import type { Conversation, Providers, TwilioCall } from "../src/providers";

export const NOW = Date.parse("2026-10-25T05:00:00Z");
export const cfg: Config = {
  publicOrigin: "https://calls.example.com", accessIssuer: "https://example.cloudflareaccess.com", accessAudience: "a".repeat(64),
  ownerEmail: "owner@example.com", ownerSubject: "owner-test", ownerName: "Test Owner",
  selfNumber: "+12025550123", callbackNumber: "+12025550123", fromNumber: "+14155550123",
  twilioAccountSid: "AC" + "1".repeat(32), twilioNumberSid: "PN" + "2".repeat(32), elevenAgentId: "agent_test", elevenPhoneId: "phone_test", voiceId: "stock_voice", agentConfigHash: "a".repeat(64),
  testOnly: true, voicemailAcceptance: null,
  budget: { monthlyUsd: 10, fixedMonthlyUsd: 1.15, additionalPerMinuteUsd: 0.1, additionalPerCallUsd: 0.02, elevenCreditsPerMinute: 1000, verifiedAt: "2026-10-25T00:00:00Z", expiresAt: "2026-10-26T00:00:00Z", source: "Synthetic testing quote, no real money" },
};
export const input: StartInput = {
  request_id: "test-reminder-1", task_type: "reminder", recipient: "self", objective: "Leave a reminder", context: "This is a synthetic test.", success_criteria: ["One full message after the beep"], constraints: { permitted_commitments: [], acceptable_alternatives: [], information_may_disclose: ["The supplied reminder"] }, voicemail: { action: "leave_message", message: "Automated recorded test reminder: recycle tomorrow." },
};
export function conversation(task: Task, outcome = "voicemail_attempted"): Conversation {
  return {
    agent_id: cfg.elevenAgentId, conversation_id: "conv_test", user_id: task.id, status: "done", has_audio: true,
    transcript: [{ role: "user", message: "Leave a message after the beep.", time_in_call_secs: 0 }, { role: "agent", message: input.voicemail.action === "leave_message" ? input.voicemail.message : "", time_in_call_secs: 12 }],
    metadata: { start_time_unix_secs: NOW / 1000, call_duration_secs: 30, cost_fiat: 0.05, phone_call: { type: "twilio", call_sid: "CA" + "3".repeat(32), phone_number_id: cfg.elevenPhoneId, agent_number: cfg.fromNumber, external_number: task.to, direction: "outbound" } },
    analysis: { transcript_summary: "A reminder was spoken after the greeting.", data_collection_results: { outcome: { value: outcome, rationale: "Based on transcript" }, confirmation: { value: "", rationale: "No confirmation" }, unresolved: { value: "Mailbox receipt requires owner confirmation", rationale: "No receipt evidence" } } },
  };
}
export function fakeProviders() {
  let captured: Task;
  const p = {
    preflight: vi.fn(async (_to: string, _duration: number, now: number) => ({ reservationMicros: 400_000, creditsAvailable: 100000, twilioBalanceUsd: 10, twilioPerMinuteUsd: 0.014, checkedAt: now, accountSid: cfg.twilioAccountSid, agentId: cfg.elevenAgentId, model: "gpt-4.1-mini", voiceId: cfg.voiceId })),
    dispatch: vi.fn(async (task: Task) => { captured = structuredClone(task); return { success: true, message: "initiated", conversation_id: "conv_test", callSid: "CA" + "3".repeat(32) }; }),
    conversation: vi.fn(async () => conversation(captured)),
    findConversation: vi.fn(async (_task: Task): Promise<Conversation | null> => null),
    call: vi.fn(async (task: Task): Promise<TwilioCall> => ({ sid: task.callSid!, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: task.to, status: "in-progress", price: null, price_unit: "USD", start_time: "Sun, 25 Oct 2026 05:00:00 +0000", duration: "30" })),
    terminate: vi.fn(async () => {}),
    audio: vi.fn(async () => new Response("fake-audio", { headers: { "Content-Type": "audio/mpeg" } })),
  } satisfies Providers;
  return p;
}
