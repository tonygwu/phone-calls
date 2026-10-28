import type { Config } from "../src/config";
import type { StartInput } from "../src/contracts";

export const NOW = Date.parse("2026-10-25T05:00:00Z");
export const cfg: Config = {
  publicOrigin: "https://calls.example.com", accessIssuer: "https://example.cloudflareaccess.com", accessAudience: "a".repeat(64),
  ownerEmail: "owner@example.com", ownerSubject: "owner-test", ownerName: "Test Owner",
  selfNumber: "+12025550123", callbackNumber: "+12025550123", fromNumber: "+14155550123",
  twilioAccountSid: "AC" + "1".repeat(32), twilioNumberSid: "PN" + "2".repeat(32), elevenAgentId: "agent_test", elevenPhoneId: "phone_test", voiceId: "stock_voice",
};
export const input: StartInput = {
  request_id: "test-reminder-1", task_type: "reminder", recipient: "self", objective: "Leave a reminder", context: "This is a synthetic test.", success_criteria: ["One full message after the beep"], constraints: { permitted_commitments: [], acceptable_alternatives: [], information_may_disclose: ["The supplied reminder"] }, voicemail: { action: "leave_message", message: "Automated recorded test reminder: recycle tomorrow." },
};
