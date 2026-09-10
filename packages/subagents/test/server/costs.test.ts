import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ownSessionCost, SubagentCosts } from "../../src/server/costs.ts";
import { inheritedContextEntryType } from "../../src/server/fork-history.ts";

const usage = (total: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const assistant = (cost: number) => ({ role: "assistant" as const, content: [], api: "openai-responses" as const, provider: "openai", model: "test", usage: usage(cost), stopReason: "stop" as const, timestamp: 1 });
const entries = (cost: number): SessionEntry[] => [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01", message: assistant(cost) }];

test("excludes inherited charges but includes new input and auxiliary usage across branches", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(assistant(10));
  manager.appendCustomEntry(inheritedContextEntryType);
  const fork = manager.getLeafId()!;
  manager.appendMessage(assistant(2));
  manager.branch(fork);
  manager.appendMessage(assistant(4));
  const recorded = manager.getEntries();
  const summary: SessionEntry = { type: "compaction", id: "c", parentId: null, timestamp: "2026-01-01", summary: "summary", firstKeptEntryId: "a", tokensBefore: 1, usage: usage(3) };
  const branchSummary: SessionEntry = { type: "branch_summary", id: "b", parentId: null, timestamp: "2026-01-01", summary: "summary", fromId: "a", usage: usage(5) };
  const tool: SessionEntry = { type: "message", id: "t", parentId: null, timestamp: "2026-01-01", message: { role: "toolResult", toolCallId: "call", toolName: "test", content: [], isError: false, timestamp: 1, usage: usage(6) } };
  expect(ownSessionCost([...recorded, summary, branchSummary, tool])).toBe(20);
  expect(ownSessionCost(entries(2))).toBe(2);
});

test("rolls up all descendants, retaining closed agents and notifying idle ancestors", async () => {
  const agents = [{ id: "child", parentId: "root", status: "closed" }, { id: "grandchild", parentId: "child" }];
  const costs = new SubagentCosts(() => agents, async () => { throw new Error("Cached sessions must not be read"); });
  costs.update("root", entries(0.23));
  costs.update("child", entries(2));
  costs.update("grandchild", entries(0.45));
  expect(await costs.snapshot("root")).toEqual({ cost: 0.23, descendantCost: 2.45, isSubagent: false });
  expect(await costs.snapshot("grandchild")).toEqual({ cost: 0.45, descendantCost: undefined, isSubagent: true });
  let changes = 0;
  const unsubscribe = costs.subscribe("root", () => changes++);
  costs.update("grandchild", entries(1));
  costs.update("grandchild", entries(1));
  expect((await costs.snapshot("root")).descendantCost).toBe(3);
  expect(changes).toBe(2);
  unsubscribe();
  costs.update("grandchild", entries(2));
  expect(changes).toBe(2);
});

test("restores historical totals once and handles children interrupted before session creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-costs-"));
  try {
    const path = join(directory, "child.jsonl");
    const manager = SessionManager.open(path);
    manager.appendMessage(assistant(10));
    manager.appendCustomEntry(inheritedContextEntryType);
    manager.appendMessage(assistant(2));
    const original = await Bun.file(path).text();
    let reads = 0;
    const costs = new SubagentCosts(() => [{ id: "child", parentId: "root" }, { id: "missing", parentId: "root" }], async (id) => { reads++; return join(directory, `${id}.jsonl`); });
    costs.update("root", entries(1));
    expect((await costs.snapshot("root")).descendantCost).toBe(2);
    expect((await costs.snapshot("root")).descendantCost).toBe(2);
    expect(reads).toBe(2);
    expect(await Bun.file(path).text()).toBe(original);
    expect(await Bun.file(join(directory, "missing.jsonl")).exists()).toBe(false);
    costs.update("missing", entries(3));
    expect((await costs.snapshot("root")).descendantCost).toBe(5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
