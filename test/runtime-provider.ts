import { cfg } from "./data";

// Entire provider boundary is synthetic. Unknown URLs fail without network fallback.
export function runtimeProvider() {
  const calls = new Map<string, { user: string; to: string; sid: string; started: number }>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname;
    if (!["api.elevenlabs.io", "api.twilio.com"].includes(url.hostname)) throw new Error(`Unexpected outbound request in test: ${request.method} ${request.url}`);
    if (url.hostname === "api.elevenlabs.io" && request.headers.get("xi-api-key") !== "synthetic-runtime-key") throw new Error("Unexpected test credential");
    if (url.hostname.endsWith(".twilio.com") && request.headers.get("Authorization") !== `Basic ${btoa(`${cfg.twilioAccountSid}:synthetic-runtime-token`)}`) throw new Error("Unexpected test credential");
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
    if (url.hostname === "api.elevenlabs.io") {
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
    const account = `/2010-04-01/Accounts/${cfg.twilioAccountSid}`;
    if (url.hostname === "api.twilio.com") {
      const call = [...calls.values()].find(c => path === account + `/Calls/${c.sid}.json`);
      if (call) return Response.json({ sid: call.sid, account_sid: cfg.twilioAccountSid, from: cfg.fromNumber, to: call.to, status: "completed", price: "-0.014", price_unit: "USD", start_time: null, duration: "20" });
    }
    throw new Error(`Unexpected outbound request in test: ${request.method} ${request.url}`);
  };
}
