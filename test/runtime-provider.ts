import { cfg, sipCfg } from "./data";

// Entire provider boundary is synthetic. Unknown URLs fail without network fallback.
export function runtimeProvider() {
  const calls = new Map<string, { user: string; to: string; sid: string; started: number }>();
  const conferenceCalls = new Map<string, { user: string; role: string; sid: string; from: string; to: string; status: string; room: string; direction: string }>();
  const registered = new Map<string, { to: string; assistantSid: string }>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname;
    if (!["api.elevenlabs.io", "api.twilio.com"].includes(url.hostname)) throw new Error(`Unexpected outbound request in test: ${request.method} ${request.url}`);
    if (url.hostname === "api.elevenlabs.io" && request.headers.get("xi-api-key") !== "synthetic-runtime-key") throw new Error("Unexpected test credential");
    if (url.hostname.endsWith(".twilio.com") && request.headers.get("Authorization") !== `Basic ${btoa(`${cfg.twilioAccountSid}:synthetic-runtime-token`)}`) throw new Error("Unexpected test credential");
    const account = `/2010-04-01/Accounts/${cfg.twilioAccountSid}`;
    if (url.hostname === "api.twilio.com" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const participant = path.match(new RegExp(`^${account}/Conferences/(phone-[0-9a-f-]+|CF[0-9a-f]{32})/Participants.json$`));
      if (participant || path === account + "/Calls.json") {
        const role = participant ? form.get("Label")! : "owner";
        const callback = new URL(form.get("StatusCallback")!);
        const user = callback.searchParams.get("call_id")!;
        const sip = role === "assistant" && form.get("To")?.startsWith("sip:");
        if (!/^[0-9a-f-]{36}$/.test(user) || !["business", "assistant", "owner"].includes(role) || form.get("From") !== (sip ? "assistant-" + user : cfg.fromNumber)) throw new Error("Unexpected conference participant");
        const sid = "CA" + crypto.randomUUID().replaceAll("-", "");
        const room = "CF" + user.replaceAll("-", "");
        if (sip) {
          if (form.get("To") !== `sip:${sipCfg.conferenceSip!.identifier}@sip.rtc.elevenlabs.io:5061;transport=tls;secure=true` || form.get("SipAuthUsername") !== sipCfg.conferenceSip!.username || form.get("SipAuthPassword") !== "synthetic-sip-password") throw new Error("Wrong SIP routing or authentication");
        } else if (role === "assistant" && form.get("To") !== `app:${cfg.twilioApplicationSid}?call_id=${user}`) throw new Error("Wrong TwiML application");
        if (role === "owner" && form.get("To") !== cfg.selfNumber) throw new Error("Wrong owner destination");
        // Twilio strips custom parameters from the outbound Calls resource, and
        // invokes the App on a separate inbound call whose destination is its SID.
        conferenceCalls.set(sid, { user, role, sid, room, from: form.get("From")!, to: form.get("To")!.split("?")[0], status: "in-progress", direction: "outbound-api" });
        if (role === "assistant" && !sip) {
          const appSid = "CA" + user.replaceAll("-", "");
          conferenceCalls.set(appSid, { user, role: "assistant-app", sid: appSid, room, from: cfg.fromNumber, to: cfg.twilioApplicationSid!, status: "in-progress", direction: "inbound" });
        }
        if (participant) return Response.json({ account_sid: cfg.twilioAccountSid, conference_sid: room, call_sid: sid, label: role });
        return Response.json({ sid, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: form.get("To"), status: "queued", price: null, price_unit: null, start_time: null, duration: null });
      }
      const endingCall = [...conferenceCalls.values()].find(call => path === account + `/Calls/${call.sid}.json`);
      if (endingCall && ["canceled", "completed"].includes(form.get("Status")!)) {
        endingCall.status = form.get("Status")!;
        return Response.json({ sid: endingCall.sid, account_sid: cfg.twilioAccountSid, from: endingCall.from, to: endingCall.to, direction: endingCall.direction, status: endingCall.status, price: "-0.01", price_unit: "USD", start_time: null, duration: null });
      }
      const endingRoom = [...conferenceCalls.values()].find(call => path === account + `/Conferences/${call.room}.json`);
      if (endingRoom && form.get("Status") === "completed") {
        for (const call of conferenceCalls.values()) if (call.room === endingRoom.room) call.status = "completed";
        return Response.json({ sid: endingRoom.room, account_sid: cfg.twilioAccountSid, friendly_name: "phone-" + endingRoom.user, status: "completed" });
      }
      throw new Error("Unexpected conference mutation");
    }
    if (url.hostname === "api.elevenlabs.io" && path === "/v1/convai/twilio/register-call" && request.method === "POST") {
      const body = await request.json() as any;
      const user = body.conversation_initiation_client_data.user_id;
      const assistant = [...conferenceCalls.values()].find(call => call.user === user && call.role === "assistant-app");
      if (!assistant || body.agent_id !== cfg.elevenAgentId || body.from_number !== cfg.fromNumber || registered.has(user)) throw new Error("Unexpected or repeated conference registration");
      registered.set(user, { to: body.to_number, assistantSid: assistant.sid });
      return new Response('<Response><Connect><Stream url="wss://synthetic.example.invalid/audio"/></Connect></Response>');
    }
    if (url.hostname === "api.elevenlabs.io" && request.method === "POST" && path === "/v1/convai/twilio/outbound-call") {
      const body = await request.json() as any;
      const user = body.conversation_initiation_client_data.user_id;
      if (body.agent_id !== cfg.elevenAgentId || body.agent_phone_number_id !== cfg.elevenPhoneId) throw new Error("Wrong provider identity");
      if (calls.has(user)) throw new Error("Duplicate synthetic dispatch");
      const call = { user, to: body.to_number, sid: "CA" + user.replaceAll("-", ""), started: Math.floor(Date.now() / 1000) };
      calls.set(user, call);
      return Response.json({ success: true, message: "synthetic dispatch", conversation_id: user, callSid: call.sid });
    }
    if (request.method !== "GET") throw new Error("Unexpected test method");
    const conferenceCall = [...conferenceCalls.values()].find(call => url.hostname === "api.twilio.com" && path === account + `/Calls/${call.sid}.json`);
    if (conferenceCall) return Response.json({ sid: conferenceCall.sid, account_sid: cfg.twilioAccountSid, from: conferenceCall.from, to: conferenceCall.to, direction: conferenceCall.direction, status: conferenceCall.status, price: "-0.01", price_unit: "USD", start_time: null, duration: null });
    const readRoom = [...conferenceCalls.values()].find(call => url.hostname === "api.twilio.com" && path === account + `/Conferences/${call.room}.json`);
    if (readRoom) return Response.json({ sid: readRoom.room, account_sid: cfg.twilioAccountSid, friendly_name: "phone-" + readRoom.user, status: [...conferenceCalls.values()].some(call => call.room === readRoom.room && call.status === "in-progress") ? "in-progress" : "completed" });
    if (url.hostname === "api.elevenlabs.io") {
      if (path === "/v1/convai/conversations" && url.searchParams.has("user_id")) {
        const user = url.searchParams.get("user_id")!;
        return Response.json({ conversations: registered.has(user) ? [{ conversation_id: user, agent_id: cfg.elevenAgentId }] : [], has_more: false });
      }
      const sipCall = [...conferenceCalls.values()].find(call => call.user === path.split("/").at(-1) && call.role === "assistant" && call.to.startsWith("sip:"));
      if (sipCall && path === `/v1/convai/conversations/${sipCall.user}`) return Response.json({
        agent_id: cfg.elevenAgentId, conversation_id: sipCall.user, user_id: sipCall.user, status: sipCall.status === "in-progress" ? "in-progress" : "done", has_audio: false, transcript: [],
        metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000), call_duration_secs: 20, cost_fiat: 0.05,
          phone_call: { type: "sip_trunking", direction: "inbound", call_sid: sipCall.sid, phone_number_id: sipCfg.conferenceSip!.phoneId, agent_number: sipCfg.conferenceSip!.identifier, external_number: "synthetic-source" } },
        analysis: { transcript_summary: "Synthetic direct SIP conference." },
      });
      const conference = registered.get(path.split("/").at(-1)!);
      if (conference && path === `/v1/convai/conversations/${path.split("/").at(-1)!}`) {
        const user = path.split("/").at(-1)!;
        const active = [...conferenceCalls.values()].some(call => call.user === user && call.status === "in-progress");
        return Response.json({ agent_id: cfg.elevenAgentId, conversation_id: user, user_id: user, status: active ? "in-progress" : "done", has_audio: false,
          transcript: [], metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000), call_duration_secs: 20, cost_fiat: 0.05,
            phone_call: { type: "twilio", call_sid: conference.assistantSid, phone_number_id: cfg.elevenPhoneId, agent_number: cfg.fromNumber, external_number: conference.to, direction: "outbound" } },
          analysis: { transcript_summary: "Synthetic conference conversation." } });
      }
      if (path.endsWith("/runtime-redirect-probe/audio")) return new Response(null, { status: 302, headers: { Location: "https://unexpected.example.invalid/" } });
      if (path.endsWith("/runtime-fetch-probe/audio")) return new Response(new Uint8Array([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });
      const call = calls.get(path.split("/").at(-1)!);
      if (call && path === `/v1/convai/conversations/${call.user}`) return Response.json({
        agent_id: cfg.elevenAgentId, conversation_id: call.user, user_id: call.user, status: "done", has_audio: false,
        transcript: [{ role: "agent", time_in_call_secs: 0, tool_calls: [{ tool_name: "end_call" }] }],
        metadata: { start_time_unix_secs: call.started, call_duration_secs: 20, cost_fiat: 0.05, phone_call: { type: "twilio", call_sid: call.sid, phone_number_id: cfg.elevenPhoneId, agent_number: cfg.fromNumber, external_number: call.to, direction: "outbound" } },
        analysis: { transcript_summary: "Synthetic completed conversation." },
      });
    }
    if (url.hostname === "api.twilio.com") {
      const call = [...calls.values()].find(c => path === account + `/Calls/${c.sid}.json`);
      if (call) return Response.json({ sid: call.sid, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: call.to, status: "completed", price: "-0.014", price_unit: "USD", start_time: null, duration: "20" });
    }
    throw new Error(`Unexpected outbound request in test: ${request.method} ${request.url}`);
  };
}
