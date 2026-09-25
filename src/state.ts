import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expand, fail } from "./client.js";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const statePath = () => expand(process.env.T3THREADS_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "t3threads"));

/** This is t3threads' own state, never T3's database. Transactions coordinate CLI/MCP/worker processes. */
export class State {
  constructor(readonly directory = statePath()) {}
  transaction<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const path = join(this.directory, "state.sqlite");
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS entries (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id)); BEGIN IMMEDIATE");
      const value = fn(db);
      db.exec("COMMIT");
      return value;
    } finally { db.close(); }
  }
  get<T>(kind: string, id: string): T | undefined {
    return this.transaction(db => { const row = db.prepare("SELECT value FROM entries WHERE kind=? AND id=?").get(kind, id); return row ? JSON.parse(String(row.value)) as T : undefined; });
  }
  put(kind: string, id: string, value: unknown) {
    this.transaction(db => { db.prepare("INSERT OR REPLACE INTO entries VALUES (?,?,?)").run(kind, id, JSON.stringify(value)); });
  }
  remove(kind: string, id: string) { this.transaction(db => { db.prepare("DELETE FROM entries WHERE kind=? AND id=?").run(kind, id); }); }
  list<T>(kind: string): T[] {
    return this.transaction(db => db.prepare("SELECT value FROM entries WHERE kind=? ORDER BY id").all(kind).map(row => JSON.parse(String(row.value)) as T));
  }
  update<T>(kind: string, id: string, fn: (value: T | undefined) => T): T {
    return this.transaction(db => {
      const row = db.prepare("SELECT value FROM entries WHERE kind=? AND id=?").get(kind, id);
      const value = fn(row ? JSON.parse(String(row.value)) as T : undefined);
      db.prepare("INSERT OR REPLACE INTO entries VALUES (?,?,?)").run(kind, id, JSON.stringify(value));
      return value;
    });
  }
  async lock<T>(id: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const owner = crypto.randomUUID(), deadline = Date.now() + 120_000;
    while (true) {
      const lease = this.update<{ owner: string; pid: number }>("lock", id, current => {
        if (current) { try { process.kill(current.pid, 0); return current; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") return current; } }
        return { owner, pid: process.pid };
      });
      if (lease.owner === owner) break;
      if (Date.now() >= deadline) fail("STATE_BUSY", "Another t3threads process is renewing this credential. Try again after it finishes.");
      await delay(100, undefined, { signal });
    }
    try { return await fn(); }
    finally { this.transaction(db => { db.prepare("DELETE FROM entries WHERE kind='lock' AND id=? AND json_extract(value,'$.owner')=?").run(id, owner); }); }
  }
}
