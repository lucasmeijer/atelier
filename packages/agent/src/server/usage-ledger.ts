import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAtelierRuntimeContext } from "@atelier/core";
import type { Usage } from "@earendil-works/pi-ai";

export interface MeasuredUsage {
  from: string;
  to: string;
  trackingSince: string;
  partialCoverage: boolean;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** Installation-local accounting of new inference responses, independent of session history. */
export class UsageLedger {
  private readonly db: Database;
  readonly trackingSince: string;

  constructor(path: string, now = new Date()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tracking (id INTEGER PRIMARY KEY CHECK (id = 1), since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, completed_at TEXT NOT NULL,
        input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, total_tokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS responses_provider_time ON responses(provider, completed_at);`);
    this.db.query("INSERT OR IGNORE INTO tracking (id, since) VALUES (1, ?)").run(now.toISOString());
    this.trackingSince = this.db.query<{ since: string }, []>("SELECT since FROM tracking WHERE id = 1").get()!.since;
  }

  record(provider: string, model: string, usage: Usage, completedAt = new Date()): void {
    this.db.query(`INSERT INTO responses (id, provider, model, completed_at, input, output, cache_read, cache_write, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), provider, model, completedAt.toISOString(), usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens);
  }

  /** Half-open UTC interval. Tokens are attributed to response completion, not prompt submission. */
  measure(provider: string, from: Date, to: Date): MeasuredUsage {
    if (from > to) throw new Error("Usage interval must end after it starts");
    const totals = this.db.query<Pick<MeasuredUsage, "requests" | "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">, [string, string, string]>(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
        COALESCE(SUM(cache_read), 0) AS cacheRead, COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(total_tokens), 0) AS totalTokens
      FROM responses WHERE provider = ? AND completed_at >= ? AND completed_at < ?
    `).get(provider, from.toISOString(), to.toISOString())!;
    return { from: from.toISOString(), to: to.toISOString(), trackingSince: this.trackingSince, partialCoverage: from.toISOString() < this.trackingSince, ...totals };
  }

  close(): void { this.db.close(); }
}

let ledger: UsageLedger | undefined;
export function getUsageLedger(): UsageLedger {
  return ledger ??= new UsageLedger(join(getAtelierRuntimeContext().atelierDataDir, "usage", "responses.sqlite"));
}
