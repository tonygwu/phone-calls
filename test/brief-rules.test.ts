import { describe, expect, it } from "vitest";
import { startSchema, type Task } from "../src/contracts";
import { dispatchBody } from "../src/agent";
import { cfg, input, NOW } from "./data";
import reminderExample from "../examples/reminder.json";
import cancellationExample from "../examples/cancellation.json";

const task = (data: unknown): Task => ({ id: "00000000-0000-4000-8000-000000000001", input: startSchema.parse(data), to: cfg.selfNumber, created: NOW, expires: NOW + 1000, duration: 180, telephone: "pending", outcome: "pending", cancelRequested: false, nextCheck: NOW, attempts: 0 });

describe("optional silent rules", () => {
  it("keeps the published reminder and cancellation examples valid", () => {
    expect(startSchema.safeParse(reminderExample).success).toBe(true);
    expect(startSchema.safeParse(cancellationExample).success).toBe(true);
  });
  it("keeps old clients valid and sends an empty rules value", () => {
    const vars = dispatchBody(task(input), cfg).conversation_initiation_client_data.dynamic_variables;
    expect(vars.context).toBe(input.context);
    expect(vars.rules).toBe("[]");
  });
  it("keeps facts separate and sends trimmed rules as JSON", () => {
    const rules = [" Answer only the question asked. ", "Do not treat not found as a cancellation."];
    const vars = dispatchBody(task({ ...input, rules }), cfg).conversation_initiation_client_data.dynamic_variables;
    expect(JSON.parse(vars.rules)).toEqual(rules.map(rule => rule.trim()));
    expect(vars.context).toBe(input.context);
    expect(vars.objective).toBe(input.objective);
    expect(vars.voicemail_message).toBe(input.voicemail.message);
  });
  it("allows an explicit empty array and exact limits", () => {
    expect(startSchema.parse({ ...input, rules: [] }).rules).toEqual([]);
    expect(startSchema.parse({ ...input, rules: Array(20).fill("a".repeat(500)) }).rules).toHaveLength(20);
  });
  it.each([Array(21).fill("One rule"), ["a".repeat(501)], [" "], [123], "One rule", null])("rejects malformed or oversized rules %j", rules => {
    expect(startSchema.safeParse({ ...input, rules }).success).toBe(false);
  });
});
