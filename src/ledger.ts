import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { config, type Env } from "./config";
import { CallError, cancelSchema, getSchema, listSchema, publicError } from "./contracts";
import { CallEngine } from "./engine";
import { LiveProviders } from "./providers";
import { SqlStore } from "./store";
import { LiveConferenceProviders } from "./conference-provider";
import { callId } from "./contracts";

export class CallLedger extends DurableObject<Env> {
  private store: SqlStore;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.store = new SqlStore(ctx.storage); }
  private engine() { const c = config(this.env); return new CallEngine(this.store, new LiveProviders(this.env, c), c, Date.now, new LiveConferenceProviders(this.env, c)); }
  private async schedule() {
    const next = this.store.nextAlarm();
    if (next !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next));
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    try { await this.engine().tick(); }
    finally { await this.schedule(); }
  }
  async fetch(request: Request) {
    try {
      const engine = this.engine();
      const path = new URL(request.url).pathname;
      if (path.startsWith("/audio/")) {
        const task = engine.require(path.slice(7));
        if (!task.conversationId || !task.hasAudio) throw new CallError("RECORDING_UNAVAILABLE", "Recording is not available.", false, 404);
        const audio = await engine.providers.audio(task.conversationId);
        return new Response(audio.body, { status: 200, headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="${task.id}.mp3"` } });
      }
      const body = await request.json();
      let data: Record<string, unknown>;
      if (path.startsWith("/conference-")) {
        const args = z.object({ call_id: callId, sid: z.string().regex(/^CA[0-9a-fA-F]{32}$/).optional(), role: z.enum(["business", "assistant", "owner"]).optional(), authorization: z.string().nullable().optional(), digits: z.string().optional() }).parse(body);
        const conference = engine.conferences!;
        if (path === "/conference-owner") {
          conference.authorize(args.call_id, args.authorization ?? null);
          data = await conference.connectOwner(args.call_id);
        } else if (path === "/conference-status" && args.sid && args.role) {
          await conference.status(args.call_id, args.role, args.sid); data = { persisted: true };
        } else {
          let xml: string;
          if (path === "/conference-assistant" && args.sid) xml = await conference.assistant(args.call_id, args.sid);
          else if (path === "/conference-owner-answer" && args.sid) xml = await conference.ownerAnswer(args.call_id, args.sid, args.digits);
          else throw new CallError("INVALID_INPUT", "Invalid conference operation.");
          await this.schedule();
          return new Response(xml, { headers: { "Content-Type": "application/xml", "Cache-Control": "no-store" } });
        }
      } else if (path === "/start") data = await engine.start(body);
      else if (path === "/get") {
        const args = getSchema.parse(body);
        data = engine.view(engine.require(args.call_id), args.include_transcript, args.transcript_offset, args.limit);
      } else if (path === "/cancel") data = await engine.cancel(cancelSchema.parse(body).call_id);
      else if (path === "/list") {
        const args = listSchema.parse(body);
        let before: { created: number; id: string } | undefined;
        if (args.cursor) {
          try { before = z.object({ created: z.number().int(), id: z.string().uuid() }).parse(JSON.parse(atob(args.cursor))); }
          catch { throw new CallError("INVALID_CURSOR", "Call-history cursor is invalid."); }
        }
        const tasks = this.store.list(before, args.limit + 1).filter(t => t.expires > Date.now());
        const page = tasks.slice(0, args.limit);
        const last = page.at(-1);
        data = { calls: page.map(t => engine.view(t)), next_cursor: tasks.length > args.limit && last ? btoa(JSON.stringify({ created: last.created, id: last.id })) : null };
      } else if (path === "/callback") {
        const args = z.object({ conversation_id: z.string().min(1) }).parse(body);
        await engine.callback(args.conversation_id); data = { persisted: true };
      } else throw new CallError("NOT_FOUND", "Unknown operation.", false, 404);
      await this.schedule();
      return Response.json({ ok: true, data });
    } catch (error) {
      return Response.json({ ok: false, error: publicError(error) }, { status: error instanceof CallError ? error.status : 400 });
    }
  }
}
