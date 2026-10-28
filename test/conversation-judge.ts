import { z } from "zod";

export const JUDGE_PROTOCOL = "short-call-text-v3";

export interface JudgeScenario {
  taskType: "booking" | "reminder" | "general" | "support";
  phone: string;
  name: string;
  facts: { id: string; pattern: string }[];
  voicemailMessage?: string;
  closingAfterUser?: string;
  requiredFacts?: string[];
  forbiddenSpeechPatterns?: string[];
  openingPurposePattern?: string;
}

const turnSchema = z.object({
  role: z.enum(["agent", "user"]), message: z.string().nullable(),
  tool_calls: z.array(z.object({ tool_name: z.string(), params_as_json: z.string(), tool_has_been_called: z.boolean().optional() }).passthrough()).nullable().optional(),
}).passthrough();
const words = (text: string) => text.match(/[\p{L}\p{N}]+(?:['’:-][\p{L}\p{N}]+)*/gu) ?? [];
const normalized = (text: string) => words(text).join(" ").toLowerCase();
const sentences = (text: string) => text.split(/[.!?]+(?:\s|$)/).filter(part => part.trim()).length;
const acknowledgement = /^(?:okay|ok|uh huh|mhm|all right|alright|sure)[.!\s-]*$/i;
const machineGreeting = /beep|leave (?:a |your )?message|answering machine|voicemail/i;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const asksFor = (text: string, topic: RegExp) => topic.test(text) && (text.includes("?") || /\b(?:please|tell me|give me|what|which|when|who|(?:can|could|would|may) (?:I|you))\b/i.test(text));
const spokenDigits = (text: string) => {
  const digits: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  return text.toLowerCase().replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, token => digits[token]).replace(/\D/g, "");
};

/** Text checks are deliberately literal. They do not judge acoustic delivery or infer task success. */
export function judgeConversation(input: unknown, scenario: JudgeScenario) {
  const turns = z.array(turnSchema).min(1).parse(input);
  if (!/^\+?\d[\d .()-]{8,}$/.test(scenario.phone) || scenario.phone.replace(/\D/g, "").length < 10 || !scenario.name.trim()) throw new Error("A scenario needs a nonempty name and a full phone number.");
  const checks: { id: string; passed: boolean; details: string }[] = [];
  const check = (id: string, passed: boolean, details: string) => checks.push({ id, passed, details });
  const speech: { text: string; previousUser: string; previousUserIndex: number; index: number; closing: boolean }[] = [];
  let previousUser = "";
  let previousUserIndex = -1;
  let endCallCount = 0;
  let lastEndIndex = -1;
  let allExecuted = true;
  for (const [index, turn] of turns.entries()) {
    if (turn.role === "user") { previousUser = turn.message ?? ""; previousUserIndex = index; continue; }
    for (const call of turn.tool_calls ?? []) {
      z.record(z.string(), z.unknown()).parse(JSON.parse(call.params_as_json));
      if (call.tool_has_been_called === false) allExecuted = false;
    }
    const endings = (turn.tool_calls ?? []).filter(call => call.tool_name === "end_call");
    for (const call of endings) {
      endCallCount++;
      lastEndIndex = index;
      const params = z.object({ system__message_to_speak: z.string().min(1) }).passthrough().parse(JSON.parse(call.params_as_json));
      // Providers can echo the same tool speech in message. Count audible text once.
      if (turn.message && turn.message.trim() !== params.system__message_to_speak.trim()) {
        speech.push({ text: turn.message, previousUser, previousUserIndex, index, closing: false });
      }
      const preceding = speech.at(-1);
      if (preceding?.text === params.system__message_to_speak && preceding.previousUser === previousUser) {
        preceding.closing = true;
      } else speech.push({ text: params.system__message_to_speak, previousUser, previousUserIndex, index, closing: true });
    }
    if (!endings.length && turn.message?.trim()) speech.push({ text: turn.message, previousUser, previousUserIndex, index, closing: false });
  }
  check("has_agent_speech", speech.length > 0, `${speech.length} spoken turns`);
  const opener = speech[0]?.text ?? "";
  const disclosure = /automated (?:telephone )?assistant/i.test(opener) && /(?:call (?:is |is being )?recorded|call is being recorded|recorded call)/i.test(opener);
  check("disclosures", disclosure, "Opener must identify automation and recording.");
  const firstTaskDetail = opener.search(/\b(?:cancel|cancellation|reservation|book|booking|transaction|dinner|remind)\b/i);
  const automationAt = opener.search(/automated (?:telephone )?assistant/i);
  const recordingAt = opener.search(/(?:call (?:is |is being )?recorded|recorded call)/i);
  check("disclosures_first", disclosure && (firstTaskDetail < 0 || firstTaskDetail > Math.max(automationAt, recordingAt)), "Automation and recording disclosures must precede substantive task details.");
  const afterDisclosure = opener.replace(/[^.!?]*automated (?:telephone )?assistant[^.!?]*[.!?]?/i, "").replace(/[^.!?]*(?:call (?:is |is being )?recorded|recorded call)[^.!?]*[.!?]?/i, "");
  const reminder = scenario.taskType === "reminder";
  const exempt = (text: string) => {
    const message = scenario.voicemailMessage;
    if (!message || text.split(message).length !== 2 || !(reminder || machineGreeting.test(speech.find(s => s.text === text)?.previousUser ?? ""))) return false;
    // Only disclosure, greeting and closing may surround the exact supplied text.
    const remainder = text.replace(message, "")
      .replace(new RegExp(`(?:this is |I am )?an? automated (?:telephone )?assistant(?: calling (?:for|on behalf of) ${escapeRegex(scenario.name)})?`, "gi"), "")
      .replace(/(?:this )?call (?:is |is being )?recorded/gi, "")
      .replace(/\b(?:hi|hello|thank you|goodbye)\b/gi, "");
    return words(remainder).length === 0;
  };
  check("opener_sentences", exempt(opener) || sentences(afterDisclosure) <= 2, `${sentences(afterDisclosure)} purpose sentences after disclosures; maximum 2`);
  if (scenario.openingPurposePattern) check("opening_purpose", new RegExp(scenario.openingPurposePattern, "i").test(afterDisclosure), "The opener must state the task's purpose after the disclosures.");
  const wordCounts = speech.map(s => words(s.text).length);
  check("turn_words", speech.every((s, i) => exempt(s.text) || wordCounts[i] <= 35), `Words by turn: ${wordCounts.join(", ")}; maximum 35 except exact supplied message`);
  let phoneMentions = 0;
  let fullDates = 0;
  const factMentions: Record<string, number> = {};
  const seen = new Set<string>();
  const repeated: string[] = [];
  const dateViolations: number[] = [];
  let unsolicitedPhone = 0;
  let repeatedRequestedPhone = false;
  const usedRequests = new Set<string>();
  for (const s of speech) {
    const askingPhone = asksFor(s.previousUser, /phone|number|digits/i);
    const mentions = spokenDigits(s.text).split(scenario.phone.replace(/\D/g, "")).length - 1;
    phoneMentions += mentions;
    if (!askingPhone) unsolicitedPhone += mentions;
    else if (mentions > 0) {
      const key = `${s.previousUserIndex}:phone-delivery`;
      if (mentions > 1 || usedRequests.has(key)) repeatedRequestedPhone = true;
      usedRequests.add(key);
    }
    const dates = s.text.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+20\d{2}\b/gi) ?? [];
    fullDates += dates.length;
    if (dates.length && (!asksFor(s.previousUser, /year|full date|complete date/i) || dates.length > 1 || usedRequests.has(`${s.previousUserIndex}:year`)) && !exempt(s.text)) dateViolations.push(s.index);
    if (dates.length) usedRequests.add(`${s.previousUserIndex}:year`);
    for (const fact of scenario.facts) {
      const matches = [...s.text.matchAll(new RegExp(fact.pattern, "gi"))];
      const matchCount = fact.id === "phone" ? mentions : matches.length;
      factMentions[fact.id] = (factMentions[fact.id] ?? 0) + matchCount;
      if (!matchCount) continue;
      const explicitlyAsked = fact.id === "name" ? asksFor(s.previousUser, /name|who/i)
        : fact.id === "phone" ? askingPhone
        : fact.id === "date" ? asksFor(s.previousUser, /date|when|day|year/i)
        : fact.id.includes("time") ? asksFor(s.previousUser, /time|when/i)
        : fact.id === "restaurant" ? asksFor(s.previousUser, /restaurant|business|where/i)
        : asksFor(s.previousUser, new RegExp(fact.id, "i"));
      const requestKey = `${s.previousUserIndex}:${fact.id}`;
      const allowedRequest = explicitlyAsked && !usedRequests.has(requestKey);
      if ((matchCount > 1 || seen.has(fact.id) && !allowedRequest) && !exempt(s.text)) repeated.push(`${fact.id} at transcript turn ${s.index}`);
      if (explicitlyAsked) usedRequests.add(requestKey);
      seen.add(fact.id);
    }
  }
  check("phone_repetition", unsolicitedPhone <= 1 && !repeatedRequestedPhone, `${phoneMentions} total phone mentions, ${unsolicitedPhone} without a number request; maximum 1 unsolicited and 1 per explicit request`);
  check("full_date", dateViolations.length === 0, `${fullDates} dates with year; unsolicited at turns ${dateViolations.join(", ")}`);
  check("fact_repetition", repeated.length === 0, repeated.join("; ") || "No unsolicited repeated tracked facts.");
  const badClarifiers = speech.filter((s, i) => acknowledgement.test(s.previousUser) && !s.closing && (words(s.text).length > 10 || !s.text.includes("?") || (i > 0 && normalized(s.text) === normalized(speech[i - 1].text))));
  check("acknowledgement_clarifier", badClarifiers.length === 0, `${badClarifiers.length} replies to a bare acknowledgement exceed 10 words, omit a question, or repeat the previous turn`);
  const closings = speech.filter(s => s.closing);
  check("end_call", endCallCount === 1 && allExecuted && speech.at(-1)?.closing === true && !turns.slice(lastEndIndex + 1).some(t => t.message?.trim() || t.role === "user"), `${endCallCount} end_call invocations; it must execute and end the conversation`);
  check("closing_sentence", closings.length === 1 && (exempt(closings[0].text) || sentences(closings[0].text) === 1), "Closing must be one sentence except a verbatim reminder or voicemail.");
  if (scenario.voicemailMessage && reminder) check("verbatim_reminder", speech.length === 1 && opener.includes(scenario.voicemailMessage) && opener.split(scenario.voicemailMessage).length === 2, "Live reminder must be complete, once, through end_call.");
  if (scenario.voicemailMessage && turns.some(t => t.role === "user" && machineGreeting.test(t.message ?? ""))) {
    const delivered = speech.filter(s => exempt(s.text));
    check("verbatim_voicemail", delivered.length === 1 && delivered[0].text.includes(scenario.voicemailMessage), "After a machine greeting, the exact supplied voicemail must be delivered once.");
  }
  if (scenario.closingAfterUser) {
    const successIndex = turns.findIndex(t => t.role === "user" && new RegExp(scenario.closingAfterUser!, "i").test(t.message ?? ""));
    // ElevenLabs renders tool speech immediately before its tool event. Permit
    // that exact adjacent pair, but no intervening tool or other spoken action.
    const following = turns.slice(successIndex + 1).filter(t => t.role === "agent" && (t.message?.trim() || t.tool_calls?.length));
    const onlyEnd = (turn: typeof turns[number] | undefined) => {
      if (turn?.tool_calls?.length !== 1 || turn.tool_calls[0].tool_name !== "end_call") return false;
      return !turn.message?.trim() || turn.message.trim() === JSON.parse(turn.tool_calls[0].params_as_json).system__message_to_speak.trim();
    };
    const immediate = onlyEnd(following[0]);
    const echoed = following[0]?.message && !following[0].tool_calls?.length && onlyEnd(following[1]) && following[0].message.trim() === JSON.parse(following[1].tool_calls![0].params_as_json).system__message_to_speak.trim();
    check("close_on_success", successIndex >= 0 && Boolean(immediate || echoed), "After success, end_call must be immediate or follow only its exact adjacent speech echo.");
  }
  for (const required of scenario.requiredFacts ?? []) check(`content_${required}`, speech.some(s => new RegExp(required, "i").test(s.text)), `Required spoken content: ${required}`);
  // An unprovided code is a mechanical fabrication; authority semantics remain separate content evaluations.
  const supplied = turns.filter(t => t.role === "user").map(t => t.message ?? "").join(" ");
  const codePattern = /(?:confirmation|cancellation|reference)\s+(?:code|number|id)?\s*(?:is|:)\s*([a-z0-9-]+)/gi;
  const invented = speech.flatMap(s => [...s.text.matchAll(codePattern)]).filter(m => !new RegExp(`\\b${escapeRegex(m[1])}\\b`, "i").test(supplied));
  check("no_invented_confirmation", invented.length === 0, `${invented.length} confirmation identifiers not supplied by the recipient`);
  for (const pattern of scenario.forbiddenSpeechPatterns ?? []) check(`authority_${pattern}`, !speech.some(s => new RegExp(pattern, "i").test(s.text)), "Speech must not claim a commitment outside this scenario's permission.");
  return { protocol: JUDGE_PROTOCOL, passed: checks.every(c => c.passed), checks, metrics: { agentWordsPerTurn: wordCounts, openerWords: words(opener).length, phoneMentions, fullDates, factMentions } };
}
