import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { config, type Env } from "./config";
import { CallError, cancelSchema, getSchema, listSchema, publicError } from "./contracts";
import { CallEngine } from "./engine";
import { LiveProviders } from "./providers";
import { SqlStore } from "./store";

export class CallLedger extends DurableObject<Env> {
  private store: SqlStore;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.store = new SqlStore(ctx.storage); }
  private engine() { const c = config(this.env); return new CallEngine(this.store, new LiveProviders(this.env, c), c); }
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
      if (path === "/start") data = await engine.start(body);
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
