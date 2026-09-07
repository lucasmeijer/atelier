import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { UsageLedger } from "../../src/server/usage-ledger.ts";

const directories: string[] = [];
const ledgers: UsageLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
const usage: Usage = { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, reasoning: 20, totalTokens: 360, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function open(path?: string): UsageLedger {
  if (!path) {
    const directory = mkdtempSync(join(tmpdir(), "atelier-usage-"));
    directories.push(directory);
    path = join(directory, "usage.sqlite");
  }
  const ledger = new UsageLedger(path, new Date("2026-09-01T00:00:00Z"));
  ledgers.push(ledger);
  return ledger;
}

test("aggregates per provider and time interval, without adding reasoning twice", () => {
  const ledger = open();
  ledger.record("openai-codex", "gpt", usage, new Date("2026-09-02T12:00:00Z"));
  ledger.record("openai-codex", "gpt-other", usage, new Date("2026-09-02T13:00:00Z"));
  ledger.record("anthropic", "claude", usage, new Date("2026-09-02T12:00:00Z"));
  ledger.record("openai-codex", "gpt", usage, new Date("2026-09-03T00:00:00Z"));
  const totals = ledger.measure("openai-codex", new Date("2026-09-02T12:00:00Z"), new Date("2026-09-03T00:00:00Z"));
  expect(totals).toMatchObject({ requests: 2, input: 200, output: 100, cacheRead: 400, cacheWrite: 20, totalTokens: 720, partialCoverage: false });
});

test("keeps zero recorded usage distinct from full coverage", () => {
  const ledger = open();
  const totals = ledger.measure("openai-codex", new Date("2026-08-01T00:00:00Z"), new Date("2026-09-01T12:00:00Z"));
  expect(totals.requests).toBe(0);
  expect(totals.totalTokens).toBe(0);
  expect(totals.partialCoverage).toBe(true);
  expect(totals.trackingSince).toBe("2026-09-01T00:00:00.000Z");
});

test("usage and tracking start survive reopening independently of workspaces", () => {
  const ledger = open();
  ledger.record("openai-codex", "gpt", usage, new Date("2026-09-02T12:00:00Z"));
  ledger.close();
  ledgers.pop();
  const reopened = new UsageLedger(join(directories[0]!, "usage.sqlite"), new Date("2026-09-04T00:00:00Z"));
  ledgers.push(reopened);
  expect(reopened.trackingSince).toBe("2026-09-01T00:00:00.000Z");
  expect(reopened.measure("openai-codex", new Date("2026-09-01T00:00:00Z"), new Date("2026-09-05T00:00:00Z")).totalTokens).toBe(360);
});

test("rejects reversed intervals", () => {
  const ledger = open();
  expect(() => ledger.measure("openai-codex", new Date("2026-09-03"), new Date("2026-09-01"))).toThrow("Usage interval");
});
