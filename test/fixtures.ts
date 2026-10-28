import { vi } from "vitest";
import type { Config } from "../src/config";
import type { StartInput, Task } from "../src/contracts";
import type { Conversation, Providers, TwilioCall } from "../src/providers";

export { cfg, input, NOW } from "./data";
import { cfg, input, NOW } from "./data";
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
    dispatch: vi.fn(async (task: Task) => { captured = structuredClone(task); return { success: true, message: "initiated", conversation_id: "conv_test", callSid: "CA" + "3".repeat(32) }; }),
    conversation: vi.fn(async () => conversation(captured)),
    findConversation: vi.fn(async (_task: Task): Promise<Conversation | null> => null),
    call: vi.fn(async (task: Task): Promise<TwilioCall> => ({ sid: task.callSid!, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: task.to, status: "in-progress", price: null, price_unit: "USD", start_time: "Sun, 25 Oct 2026 05:00:00 +0000", duration: "30" })),
    terminate: vi.fn(async () => {}),
    audio: vi.fn(async () => new Response("fake-audio", { headers: { "Content-Type": "audio/mpeg" } })),
  } satisfies Providers;
  return p;
}
