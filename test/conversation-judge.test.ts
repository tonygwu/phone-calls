import { describe, expect, it } from "vitest";
import baseline from "./fixtures/verbose-cancellation.json";
import accepted from "./fixtures/short-cancellation-accepted.json";
import scenarios from "../evals/scenarios.json";
import { judgeConversation, type JudgeScenario } from "./conversation-judge";

const scenario = scenarios.cases.find(c => c.id === "short-cancellation")!.judge as JudgeScenario;
const end = (text: string) => ({ role: "agent", message: null, tool_calls: [{ tool_name: "end_call", params_as_json: JSON.stringify({ system__message_to_speak: text }) }] });
const concise = [
  { role: "user", message: "Hello, this is Cedar Table." },
  { role: "agent", message: "Hi, this is an automated assistant; this call is recorded. Please cancel Maya Chen's reservation for tomorrow at 6:15." },
  { role: "user", message: "Can I get the name of the reservation?" },
  { role: "agent", message: "Maya Chen." },
  { role: "user", message: "It is already canceled." },
  { role: "agent", message: "Are there any other entries for that booking?" },
  { role: "user", message: "Okay." },
  { role: "agent", message: "Do any remain?" },
  { role: "user", message: "No, I do not have any other reservation." },
  end("Thanks for confirming the cancellation, goodbye."),
];

describe("literal conversation checks", () => {
  it("reproduces the captured cancellation failure", () => {
    // The original true assertion failed in call-brevity-red.txt. Preserve this
    // transcript as a permanent negative control; the provider after-arm is separate.
    const result = judgeConversation(baseline, scenario);
    expect(result.passed).toBe(false);
    expect(result.checks.filter(c => !c.passed).map(c => c.id)).toContain("turn_words");
    expect(result.metrics.phoneMentions).toBe(4);
    expect(result.metrics.fullDates).toBe(5);
  });
  it("accepts a short conversation that completes the same task", () => {
    const result = judgeConversation(concise, scenario);
    expect(result.checks.filter(c => !c.passed)).toEqual([]);
  });
  it("accepts the independently generated GPT-4.1 transcript", () => {
    const result = judgeConversation(accepted, scenario);
    expect(result.checks.filter(c => !c.passed)).toEqual([]);
    expect(result.metrics.agentWordsPerTurn).toEqual([25, 2, 8, 3, 6]);
  });
  it("rejects a plausible short conversation that never hangs up", () => {
    expect(judgeConversation(concise.slice(0, -1), scenario).checks.find(c => c.id === "end_call")?.passed).toBe(false);
  });
  it("rejects unexpected transcript and tool parameter shapes", () => {
    expect(() => judgeConversation({}, scenario)).toThrow();
    expect(() => judgeConversation([end("").tool_calls], scenario)).toThrow();
  });
  it("allows requested identifiers but rejects unsolicited repetition", () => {
    const repeated = structuredClone(concise);
    repeated[7].message = "Does Maya Chen have another reservation at 6:15?";
    expect(judgeConversation(repeated, scenario).checks.find(c => c.id === "fact_repetition")?.passed).toBe(false);
  });
  it("preserves the full verbatim live reminder exemption", () => {
    const message = "Remember to recycle tomorrow. " + "The boxes need a change of scenery. ".repeat(8).trim();
    const result = judgeConversation([{ role: "user", message: "Hello?" }, end(`This is an automated assistant; this call is recorded. ${message} Goodbye.`)], { ...scenario, taskType: "reminder", openingPurposePattern: undefined, requiredFacts: undefined, voicemailMessage: message, closingAfterUser: undefined });
    expect(result.checks.filter(c => !c.passed)).toEqual([]);
    expect(judgeConversation([{ role: "user", message: "Hello?" }, end("This is an automated assistant; this call is recorded. Remember to recycle. Goodbye.")], { ...scenario, taskType: "reminder", openingPurposePattern: undefined, requiredFacts: undefined, voicemailMessage: message, closingAfterUser: undefined }).passed).toBe(false);
  });
  it.each([
    ["details before disclosures", "Please cancel Maya Chen's reservation. This is an automated assistant; this call is recorded."],
    ["an unauthorized deposit", "I paid a deposit and moved the reservation."],
    ["an unauthorized action in a longer sentence", "I also moved another person’s reservation and paid the deposit."],
    ["a fabricated identifier", "Your cancellation code is ABC123."],
  ])("rejects %s", (_label, message) => {
    const changed = structuredClone(concise);
    if (_label === "details before disclosures") changed[1].message = message;
    else changed[5].message = message;
    expect(judgeConversation(changed, scenario).passed).toBe(false);
  });
  it("a request permits one phone delivery, not repeated readings", () => {
    const changed = structuredClone(concise);
    changed[2].message = "Can I get the phone number?";
    changed[3].message = "202-555-0148, 202-555-0148, 202-555-0148.";
    expect(judgeConversation(changed, scenario).checks.find(c => c.id === "phone_repetition")?.passed).toBe(false);
  });
  it("does not exempt unrelated speech wrapped around an exact message", () => {
    const message = "Remember to recycle tomorrow.";
    const result = judgeConversation([{ role: "user", message: "Hello?" }, end(`This is an automated assistant; this call is recorded. ${message} ${"Unrelated speech. ".repeat(50)} Goodbye.`)], { ...scenario, taskType: "reminder", openingPurposePattern: undefined, requiredFacts: undefined, voicemailMessage: message, closingAfterUser: undefined });
    expect(result.checks.find(c => c.id === "turn_words")?.passed).toBe(false);
  });
  it("consumes a request once across consecutive agent turns", () => {
    const changed = structuredClone(concise);
    changed[2].message = "Can I get the phone number?";
    changed[3].message = "202-555-0148.";
    changed.splice(4, 0, { role: "agent", message: "202-555-0148." });
    expect(judgeConversation(changed, scenario).checks.find(c => c.id === "phone_repetition")?.passed).toBe(false);
  });
  it("rejects repeated names within a requested answer", () => {
    const changed = structuredClone(concise);
    changed[3].message = "Maya Chen, Maya Chen, Maya Chen.";
    expect(judgeConversation(changed, scenario).checks.find(c => c.id === "fact_repetition")?.passed).toBe(false);
  });
  it("counts phone numbers spoken as individual digits", () => {
    const changed = structuredClone(concise);
    changed[3].message = "Two oh two, five five five, zero one four eight.";
    changed[5].message = "Two zero two, five five five, zero one four eight.";
    expect(judgeConversation(changed, scenario).metrics.phoneMentions).toBe(2);
    expect(judgeConversation(changed, scenario).passed).toBe(false);
  });
  it("rejects repeated alternate times", () => {
    const changed = structuredClone(concise);
    changed[3].message = "5:45 or 6:00.";
    changed[5].message = "5:45 or 6:00.";
    expect(judgeConversation(changed, scenario).checks.find(c => c.id === "fact_repetition")?.passed).toBe(false);
  });
  it("rejects cancellation conversations without the purpose or name", () => {
    const changed = structuredClone(concise);
    changed[1].message = "This is an automated assistant; this call is recorded. Hello.";
    changed[3].message = "Hello.";
    expect(judgeConversation(changed, scenario).passed).toBe(false);
  });
  it("requires complete voicemail delivery after a beep", () => {
    const message = "Please cancel Maya Chen's booking for tomorrow at 6:15.";
    const result = judgeConversation([{ role: "user", message: "Leave a message after the beep." }, end("This is an automated assistant; this call is recorded. Goodbye.")], { ...scenario, voicemailMessage: message, openingPurposePattern: undefined, closingAfterUser: undefined, requiredFacts: undefined });
    expect(result.passed).toBe(false);
  });
  it.each(["Leave your message.", "You have reached our answering machine.", "Leave a message after the beep."])("preserves exact supplied voicemail after %s", greeting => {
    const message = "This is an automated assistant calling for Maya Chen; this call is recorded. Please cancel Maya Chen's dinner reservation for October 29, 2026 at 6:15 under Maya Chen, phone 202-555-0148. Thank you.";
    const result = judgeConversation([{ role: "user", message: greeting }, end(message)], { ...scenario, voicemailMessage: message, closingAfterUser: undefined });
    expect(result.checks.filter(c => !c.passed)).toEqual([]);
  });
  it("rejects explicit unexecuted end_call and speech after termination", () => {
    const unexecuted = structuredClone(concise);
    Object.assign(unexecuted.at(-1)!.tool_calls![0], { tool_has_been_called: false });
    expect(judgeConversation(unexecuted, scenario).passed).toBe(false);
    expect(judgeConversation([...concise, { role: "user", message: "Wait." }], scenario).passed).toBe(false);
  });
  it("recognizes provider-rendered tool speech before its end_call event", () => {
    const echoed = structuredClone(concise);
    echoed.splice(echoed.length - 1, 0, { role: "agent", message: "Thanks for confirming the cancellation, goodbye." });
    expect(judgeConversation(echoed, scenario).checks.find(c => c.id === "close_on_success")?.passed).toBe(true);
    echoed[echoed.length - 2].message = "Let me ask one more unrelated question.";
    expect(judgeConversation(echoed, scenario).checks.find(c => c.id === "close_on_success")?.passed).toBe(false);
  });
  it("rejects any intervening tool between success and hangup", () => {
    const changed = structuredClone(concise);
    changed.splice(changed.length - 1, 0, { role: "agent", message: null, tool_calls: [{ tool_name: "skip_turn", params_as_json: "{}" }] });
    expect(judgeConversation(changed, scenario).checks.find(c => c.id === "close_on_success")?.passed).toBe(false);
    const extraSpeech = structuredClone(concise);
    extraSpeech.at(-1)!.message = "Let me ask one more unrelated question.";
    expect(judgeConversation(extraSpeech, scenario).checks.find(c => c.id === "close_on_success")?.passed).toBe(false);
  });
});
