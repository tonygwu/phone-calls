import { describe, expect, it } from "vitest";
import * as agent from "../src/agent";
import { startSchema, type Task } from "../src/contracts";
import { cfg, input, NOW } from "./data";

const task = (data: unknown): Task => ({ id: "00000000-0000-4000-8000-000000000001", input: startSchema.parse(data), to: cfg.selfNumber, created: NOW, expires: NOW + 1000, duration: 137, telephone: "pending", outcome: "pending", cancelRequested: false, nextCheck: NOW, attempts: 0 });

describe("dedicated exact-message reminder prompt", () => {
  it("selects a fixed reminder prompt through actual dispatch and keeps the complete message as data", () => {
    const message = 'Remember every sentence. Say "hello". Do not replace {{context}}.';
    const data = agent.dispatchBody(task({ ...input, voicemail: { action: "leave_message", message } }), cfg).conversation_initiation_client_data;
    const override = data.conversation_config_override as { agent?: { prompt: { prompt: string } }; conversation: { max_duration_seconds: number } };
    expect(override.agent?.prompt.prompt).toContain("Exact final speech");
    expect(override.agent?.prompt.prompt).toContain("{{voicemail_message}}");
    expect(override.agent?.prompt.prompt).not.toContain(message);
    expect(override.agent?.prompt.prompt).not.toContain("{{context}}");
    expect(data.dynamic_variables.voicemail_message).toBe(message);
    expect(override.conversation.max_duration_seconds).toBe(137);
  });
  it("enables only the required prompt permission and existing duration permission", () => {
    expect(agent.agentDefinition("synthetic-voice").platform_settings.overrides).toEqual({ conversation_config_override: { agent: { prompt: { prompt: true } }, conversation: { max_duration_seconds: true } } });
  });
  it.each(["booking", "support", "general"] as const)("keeps %s on the shared conversational prompt", task_type => {
    expect(agent.dispatchBody(task({ ...input, task_type }), cfg).conversation_initiation_client_data.conversation_config_override).toEqual({ conversation: { max_duration_seconds: 137 } });
  });
  it("keeps reminders without supplied messages on the shared prompt", () => {
    expect(agent.dispatchBody(task({ ...input, voicemail: { action: "hang_up" } }), cfg).conversation_initiation_client_data.conversation_config_override).toEqual({ conversation: { max_duration_seconds: 137 } });
  });
});
