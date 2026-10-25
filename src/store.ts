import { CallError, costsSettled, terminal, type Task } from "./contracts";

export interface Store {
  get(id: string): Task | undefined;
  byRequest(hash: string): Task | "expired" | undefined;
  put(task: Task): void;
  active(): Task | undefined;
  due(now: number): Task[];
  list(before: { created: number; id: string } | undefined, limit: number): Task[];
  used(month: string): number;
  purge(now: number): void;
  nextAlarm(): number | undefined;
  nextObservation(): number;
}

export class SqlStore implements Store {
  private sql: SqlStorage;
  constructor(private storage: DurableObjectStorage) {
    const sql = this.sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, request_hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, month TEXT NOT NULL, active INTEGER NOT NULL, next_check INTEGER NOT NULL, allowance INTEGER NOT NULL, body TEXT NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS calls_due ON calls(next_check)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS calls_page ON calls(created DESC, id DESC)`);
    // Only a non-reversible request hash survives deletion of task content. It
    // prevents an old client retry from ever dialing again after retention ends.
    sql.exec(`CREATE TABLE IF NOT EXISTS expired_requests (request_hash TEXT PRIMARY KEY)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS monthly_charges (month TEXT PRIMARY KEY, micros INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS safety_blocks (reason TEXT PRIMARY KEY)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS observation_counter (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL)`);
  }
  get(id: string) {
    const row = this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE id = ?", id).toArray()[0];
    return row ? JSON.parse(row.body) as Task : undefined;
  }
  byRequest(hash: string) {
    const row = this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE request_hash = ?", hash).toArray()[0];
    if (row) return JSON.parse(row.body) as Task;
    return this.sql.exec("SELECT 1 FROM expired_requests WHERE request_hash = ?", hash).toArray().length ? "expired" : undefined;
  }
  put(t: Task) {
    const reported = (t.twilioCostMicros ?? 0) + (t.elevenCostMicros ?? 0);
    const cost = costsSettled(t) ? reported : Math.max(t.reservationMicros, reported);
    this.sql.exec(`INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET active=excluded.active, next_check=excluded.next_check, allowance=excluded.allowance, body=excluded.body`, t.id, t.requestId, t.created, t.expires, t.month, terminal.has(t.telephone) ? 0 : 1, t.nextCheck, cost, JSON.stringify(t));
  }
  active() {
    if (this.sql.exec("SELECT 1 FROM safety_blocks LIMIT 1").toArray().length) throw new CallError("RETENTION_UNRESOLVED", "An unresolved call expired. Its content was deleted, and new calls are blocked until an operator reconciles provider state.");
    const row = this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE active=1 LIMIT 1").toArray()[0];
    return row ? JSON.parse(row.body) as Task : undefined;
  }
  due(now: number) {
    // While a call is active, defer all terminal analysis/billing work. With no
    // active call, do one background task per alarm so a backlog cannot monopolize it.
    return this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE next_check <= ? AND (active=1 OR NOT EXISTS(SELECT 1 FROM calls WHERE active=1)) ORDER BY next_check LIMIT 1", now).toArray().map(r => JSON.parse(r.body) as Task);
  }
  list(before: { created: number; id: string } | undefined, limit: number) {
    const rows = before ? this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE created < ? OR (created = ? AND id < ?) ORDER BY created DESC, id DESC LIMIT ?", before.created, before.created, before.id, limit) : this.sql.exec<{ body: string }>("SELECT body FROM calls ORDER BY created DESC, id DESC LIMIT ?", limit);
    return rows.toArray().map(r => JSON.parse(r.body) as Task);
  }
  used(month: string) {
    const a = this.sql.exec<{ total: number }>("SELECT COALESCE(SUM(allowance), 0) AS total FROM calls WHERE month = ? OR (active=1 AND month != ?)", month, month).one().total;
    const b = this.sql.exec<{ micros: number }>("SELECT micros FROM monthly_charges WHERE month = ?", month).toArray()[0];
    return a + (b ? b.micros : 0);
  }
  purge(now: number) {
    this.storage.transactionSync(() => {
    // Content expires even when a provider never resolves a call. A content-free
    // lock prevents new spending until an operator reconciles that provider.
    for (const row of this.sql.exec<{ body: string; allowance: number }>("SELECT body, allowance FROM calls WHERE expires <= ?", now).toArray()) {
      const t = JSON.parse(row.body) as Task;
      if (!terminal.has(t.telephone)) this.sql.exec("INSERT OR IGNORE INTO safety_blocks VALUES ('RETENTION_UNRESOLVED')");
      this.sql.exec("INSERT OR IGNORE INTO expired_requests VALUES (?)", t.requestId);
      this.sql.exec("INSERT INTO monthly_charges VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET micros = micros + excluded.micros", t.month, row.allowance);
      this.sql.exec("DELETE FROM calls WHERE id = ?", t.id);
    }
    });
  }
  nextAlarm() {
    const row = this.sql.exec<{ next: number | null }>("SELECT MIN(MIN(expires, CASE WHEN active=1 OR NOT EXISTS(SELECT 1 FROM calls WHERE active=1) THEN next_check ELSE expires END)) AS next FROM calls").one();
    return row.next === null ? undefined : row.next;
  }
  nextObservation() {
    return this.sql.exec<{ sequence: number }>("INSERT INTO observation_counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET sequence=sequence+1 RETURNING sequence").one().sequence;
  }
}
