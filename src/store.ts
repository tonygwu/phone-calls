import { terminal, type Task } from "./contracts";

export interface Store {
  get(id: string): Task | undefined;
  put(task: Task): void;
  due(now: number): Task[];
  list(before: { created: number; id: string } | undefined, limit: number): Task[];
  purge(now: number): void;
  nextAlarm(): number | undefined;
  nextObservation(): number;
}

export class SqlStore implements Store {
  private sql: SqlStorage;
  constructor(private storage: DurableObjectStorage) {
    const sql = this.sql = storage.sql;
    storage.transactionSync(() => {
      // Preserve existing history while removing request uniqueness and accounting.
      const columns = sql.exec<{ name: string }>("PRAGMA table_info(calls)").toArray();
      if (columns.some(column => column.name === "request_hash")) {
        sql.exec("CREATE TABLE calls_next (id TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL, next_check INTEGER NOT NULL, body TEXT NOT NULL)");
        sql.exec("INSERT INTO calls_next SELECT id, created, expires, active, next_check, body FROM calls");
        sql.exec("DROP TABLE calls");
        sql.exec("ALTER TABLE calls_next RENAME TO calls");
      }
      sql.exec("CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL, active INTEGER NOT NULL, next_check INTEGER NOT NULL, body TEXT NOT NULL)");
      sql.exec("CREATE INDEX IF NOT EXISTS calls_due ON calls(next_check)");
      sql.exec("CREATE INDEX IF NOT EXISTS calls_page ON calls(created DESC, id DESC)");
      sql.exec("DROP TABLE IF EXISTS expired_requests");
      sql.exec("DROP TABLE IF EXISTS monthly_charges");
      sql.exec("DROP TABLE IF EXISTS safety_blocks");
      sql.exec("CREATE TABLE IF NOT EXISTS observation_counter (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL)");
    });
  }
  get(id: string) {
    const row = this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE id = ?", id).toArray()[0];
    return row ? JSON.parse(row.body) as Task : undefined;
  }
  put(t: Task) {
    const active = terminal.has(t.telephone) ? 0 : 1;
    this.sql.exec("INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires, active=excluded.active, next_check=excluded.next_check, body=excluded.body", t.id, t.created, t.expires, active, t.nextCheck, JSON.stringify(t));
  }
  due(now: number) {
    // Handle all due active calls together; completed analysis waits until idle.
    const active = this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE active=1 AND next_check <= ? ORDER BY next_check", now).toArray();
    if (active.length) return active.map(row => JSON.parse(row.body) as Task);
    return this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE next_check <= ? AND NOT EXISTS(SELECT 1 FROM calls WHERE active=1) ORDER BY next_check LIMIT 1", now).toArray().map(row => JSON.parse(row.body) as Task);
  }
  list(before: { created: number; id: string } | undefined, limit: number) {
    const rows = before ? this.sql.exec<{ body: string }>("SELECT body FROM calls WHERE created < ? OR (created = ? AND id < ?) ORDER BY created DESC, id DESC LIMIT ?", before.created, before.created, before.id, limit) : this.sql.exec<{ body: string }>("SELECT body FROM calls ORDER BY created DESC, id DESC LIMIT ?", limit);
    return rows.toArray().map(row => JSON.parse(row.body) as Task);
  }
  purge(now: number) { this.sql.exec("DELETE FROM calls WHERE expires <= ?", now); }
  nextAlarm() {
    const row = this.sql.exec<{ next: number | null }>("SELECT MIN(MIN(expires, CASE WHEN active=1 OR NOT EXISTS(SELECT 1 FROM calls WHERE active=1) THEN next_check ELSE expires END)) AS next FROM calls").one();
    return row.next === null ? undefined : row.next;
  }
  nextObservation() {
    return this.sql.exec<{ sequence: number }>("INSERT INTO observation_counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET sequence=sequence+1 RETURNING sequence").one().sequence;
  }
}
