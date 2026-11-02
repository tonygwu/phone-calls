import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { authenticate, readLimited, verifyEleven, verifyTwilio } from "./auth";
import { config, secret, type Env } from "./config";
import { callId, CallError, publicError } from "./contracts";
import { createServer } from "./mcp";
export { CallLedger } from "./ledger";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const c = config(env);
      const url = new URL(request.url);
      if (url.origin !== c.publicOrigin) throw new CallError("WRONG_HOST", "This service only accepts its configured private hostname.", false, 403);
      const stub = env.CALLS.get(env.CALLS.idFromName(c.ownerSubject));
      const invoke = async (path: string, body: unknown) => {
        const res = await stub.fetch(`https://ledger/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return res.json();
      };
      if (url.pathname === "/webhooks/elevenlabs" && request.method === "POST" && !url.search) {
        const raw = await readLimited(request, 2 * 1024 * 1024);
        await verifyEleven(raw, request.headers.get("elevenlabs-signature"), secret(env, "ELEVENLABS_WEBHOOK_SECRET"));
        const event = z.object({ type: z.enum(["post_call_transcription", "call_initiation_failure"]), event_timestamp: z.number(), data: z.object({ agent_id: z.string(), conversation_id: z.string().min(1) }) }).parse(JSON.parse(raw));
        if (event.data.agent_id !== c.elevenAgentId) throw new CallError("WRONG_AGENT", "Callback does not belong to the managed agent.", false, 403);
        const response = await stub.fetch("https://ledger/callback", { method: "POST", body: JSON.stringify({ conversation_id: event.data.conversation_id }) });
        if (!response.ok) return response;
        return Response.json({ received: true });
      }
      if (url.pathname === "/webhooks/twilio/inbound" && request.method === "POST") {
        const op = url.searchParams.get("op");
        if (op === "owner") {
          if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new CallError("BAD_CONTENT_TYPE", "The owner connection tool must send JSON.", false, 415);
          const args = z.strictObject({ call_id: callId }).parse(JSON.parse(await readLimited(request, 64 * 1024)));
          return stub.fetch("https://ledger/conference-owner", { method: "POST", body: JSON.stringify({ ...args, authorization: request.headers.get("Authorization") }) });
        }
        if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) throw new CallError("BAD_CONTENT_TYPE", "Twilio must send form data.", false, 415);
        const raw = await readLimited(request, 64 * 1024);
        const form = await verifyTwilio(url.toString(), raw, request.headers.get("x-twilio-signature"), secret(env, "TWILIO_AUTH_TOKEN"));
        if (form.get("AccountSid") !== c.twilioAccountSid) throw new CallError("IDENTITY_MISMATCH", "Callback belongs to another Twilio account.", false, 403);
        if (op) {
          const sid = z.string().regex(/^CA[0-9a-fA-F]{32}$/).parse(form.get("CallSid"));
          let path: string, body: Record<string, unknown>;
          if (op === "assistant") {
            if (form.get("ApplicationSid") !== c.twilioApplicationSid) throw new CallError("IDENTITY_MISMATCH", "Callback belongs to another TwiML application.", false, 403);
            path = "conference-assistant";
            // The Participants API forwards query parameters without Param_.
            body = { call_id: callId.parse(form.get("call_id")), sid };
          } else {
            const id = callId.parse(url.searchParams.get("call_id"));
            if (op === "status") {
              path = "conference-status";
              body = { call_id: id, sid, role: z.enum(["business", "assistant", "owner"]).parse(url.searchParams.get("role")) };
            } else if (op === "owner-answer" || op === "owner-accept") {
              path = "conference-owner-answer";
              // Answering-machine detection reports its result on the first owner-answer request.
              const answeredBy = op === "owner-answer" ? form.get("AnsweredBy") : null;
              body = { call_id: id, sid, ...(op === "owner-accept" ? { digits: form.get("Digits") ?? "" } : {}), ...(answeredBy ? { answered_by: answeredBy } : {}) };
            } else throw new CallError("NOT_FOUND", "Unknown conference callback.", false, 404);
          }
          return stub.fetch(`https://ledger/${path}`, { method: "POST", body: JSON.stringify(body) });
        }
        if (url.search) throw new CallError("NOT_FOUND", "Unknown inbound callback.", false, 404);
        if (form.get("AccountSid") !== c.twilioAccountSid || form.get("To") !== c.fromNumber) throw new CallError("WRONG_NUMBER", "Inbound callback does not match the managed number.", false, 403);
        return new Response('<Response><Reject reason="rejected"/></Response>', { headers: { "Content-Type": "application/xml" } });
      }
      await authenticate(request, c);
      const origin = request.headers.get("Origin");
      if (origin && origin !== c.publicOrigin) throw new CallError("CROSS_ORIGIN", "Cross-origin browser requests are not allowed.", false, 403);
      if (url.pathname === "/mcp") {
        const raw = await readLimited(request, 64 * 1024);
        const bounded = new Request(request.url, { method: request.method, headers: request.headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: raw }) });
        return createMcpHandler(() => createServer(invoke))(bounded, env, ctx);
      }
      const audio = /^\/calls\/([0-9a-f-]{36})\/recording$/.exec(url.pathname);
      if (audio && request.method === "GET") return stub.fetch(`https://ledger/audio/${audio[1]}`);
      throw new CallError("NOT_FOUND", "Route not found.", false, 404);
    } catch (error) {
      const status = error instanceof CallError ? error.status : 400;
      return Response.json({ ok: false, error: publicError(error) }, { status, headers: { "Cache-Control": "no-store", ...(status === 401 && env.SERVICE_CONFIG ? { "WWW-Authenticate": `Bearer resource_metadata="${config(env).publicOrigin}/.well-known/oauth-protected-resource"` } : {}) } });
    }
  },
} satisfies ExportedHandler<Env>;
