import { expect, test } from "bun:test";
import { BaseAgentRuntime } from "../../src/server/base-agent-runtime.ts";
import type { AgentStatsView } from "../../src/server/render-composer.ts";
import { ids } from "../../src/server/render-context.ts";
import type { TranscriptItem } from "../../src/server/transcript.ts";

const stats: AgentStatsView = { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] };

/** Drives the same protected operations as the provider runtime without provider or filesystem I/O. */
class Runtime extends BaseAgentRuntime {
  history: TranscriptItem[] = [];
  statsBarrier = Promise.resolve();
  statsStarted = () => {};
  constructor() {
    super({ workspaceId: "routing", conversationId: "conversation", title: "Routing", label: "Agent", path: "/unused.jsonl" });
    this.resetTurnSubscriptions("session:branch");
  }
  begin(entry = "entry") { this.liveBegin({ text: "user input", images: [] }, entry); }
  beginTask(entry = "entry") { this.liveBegin(undefined, entry); }
  text(text: string, final = false) { this.liveTextDelta(text, 0, final); }
  endText() { this.liveTextEnd(0); }
  final(text: string) { this.liveFinal(text); }
  thinking(text: string) { this.liveThinkingDelta(text); }
  tool() { this.closeOpenItem(); this.liveToolExecStart({ callId: "call", name: "read", args: { path: "/file" } }); }
  toolUpdate(text: string) { this.liveToolUpdate("call", { outputText: text }); }
  toolEnd(text: string, failed = false) { this.liveToolEnd("call", text, failed); }
  failure(text: string) { this.liveNote(text, "error"); }
  finish() { this.finishLivePresentation("completed"); }
  branch(id: string) { this.resetTurnSubscriptions(id); }
  refresh() { return this.refreshTranscript(); }
  get subscribers() { return this.turnSubscriberCount; }
  get targets() { return { transcript: ids.transcript(this.ctx), turn: ids.workingItems(this.ctx, "entry:working"), text: ids.item(this.ctx, "entry:1:text") }; }
  protected modelContext() { return { systemPrompt: "", tools: [] }; }
  protected canonicalItems() { return this.history; }
  protected async statsView() { this.statsStarted(); await this.statsBarrier; return stats; }
  userMessages() { return []; }
  async submit() {}
  async compact() {}
  async abort() {}
  async dispose() { this.markDisposed(); }
  currentModel() { return undefined; }
  currentThinkingLevel() { return "off"; }
  availableThinkingLevels() { return []; }
  async setModel() {}
  async setThinkingLevel() {}
  async setServiceTier() {}
  async rewind() {}
  treeHtml() { return ""; }
  labelTreeEntry() {}
  async navigateTree() { return ""; }
  async newSession() {}
}

// Inspect protocol operation envelopes, never rendered markup or visual structure.
function operations(deliveries: string[]) {
  return deliveries.flatMap((payload) => [...payload.matchAll(/<turbo-stream\s+([^>]+)>/g)].map((match) => ({
    action: /\baction="([^"]+)"/.exec(match[1]!)?.[1],
    target: /\btarget="([^"]+)"/.exec(match[1]!)?.[1],
  })));
}

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

test("actual runtime suppresses thousands of inner operations on the main subscription", async () => {
  const runtime = new Runtime();
  const main: string[] = [];
  const subscription = runtime.subscribeLivePresentation((payload) => main.push(payload));
  await subscription.ready;
  runtime.begin();
  const count = main.length;
  const bytes = main.join("").length;
  expect(runtime.subscribers).toBe(0);
  for (let index = 0; index < 2000; index++) runtime.text("private_increment ");
  runtime.endText();
  runtime.tool();
  for (let index = 0; index < 2000; index++) runtime.toolUpdate(`private_tool_${index}`);
  runtime.toolEnd("private_tool_failure", true);
  expect(main.length).toBe(count);
  expect(main.join("").length).toBe(bytes);
  expect(runtime.subscribers).toBe(0);
  await runtime.refresh();
  // Confidential payload routing, not a check of the HTML rendering.
  expect(main.some((payload) => payload.includes("private_increment") || payload.includes("private_tool"))).toBe(false);
  runtime.failure("outside_failure");
  expect(main.length).toBeGreaterThan(count + 1);
  subscription.unsubscribe();
  await runtime.dispose();
});

test("late final promotion removes the inner operation and appends only through main", async () => {
  const runtime = new Runtime();
  runtime.begin();
  const main: string[] = [];
  const inner: string[] = [];
  const outer = runtime.subscribeLivePresentation((payload) => main.push(payload));
  const turn = runtime.subscribeTurnPresentation("entry:working", "session:branch", (payload) => inner.push(payload));
  await Promise.all([outer.ready, turn.ready]);
  main.length = inner.length = 0;
  runtime.text("late_final_private");
  runtime.endText();
  expect(main).toEqual([]);
  expect(operations(inner)).toContainEqual({ action: "append", target: runtime.targets.turn });
  inner.length = 0;
  runtime.final("late_final_private");
  expect(operations(inner)).toEqual([{ action: "remove", target: runtime.targets.text }]);
  expect(operations(main)).toEqual([{ action: "append", target: runtime.targets.transcript }]);
  const reopened: string[] = [];
  const second = runtime.subscribeTurnPresentation("entry:working", "session:branch", (payload) => reopened.push(payload));
  await second.ready;
  expect(reopened.some((payload) => payload.includes("late_final_private"))).toBe(false);
  outer.unsubscribe(); turn.unsubscribe(); second.unsubscribe();
  expect(runtime.subscribers).toBe(0);
  await runtime.dispose();
});

test("early final classification migrates an open provisional text and routes subsequent text outside", async () => {
  const runtime = new Runtime();
  runtime.begin();
  const main: string[] = [], inner: string[] = [];
  const outer = runtime.subscribeLivePresentation((payload) => main.push(payload));
  const turn = runtime.subscribeTurnPresentation("entry:working", "session:branch", (payload) => inner.push(payload));
  await Promise.all([outer.ready, turn.ready]);
  runtime.text("provisional");
  main.length = inner.length = 0;
  runtime.text(" certainly final", true);
  runtime.endText();
  expect(operations(inner)).toEqual([{ action: "remove", target: runtime.targets.text }]);
  expect(operations(main)).toContainEqual({ action: "append", target: runtime.targets.transcript });
  outer.unsubscribe(); turn.unsubscribe(); await runtime.dispose();
});

test("a delayed main snapshot remains first and does not receive interleaved inner payload", async () => {
  const runtime = new Runtime();
  runtime.begin();
  const barrier = deferred();
  runtime.statsBarrier = barrier.promise;
  const started = deferred();
  runtime.statsStarted = started.resolve;
  const main: string[] = [];
  const subscription = runtime.subscribeLivePresentation((payload) => main.push(payload));
  await started.promise;
  runtime.text("private_during_snapshot");
  runtime.endText();
  runtime.final("public_final");
  expect(main).toEqual([]);
  barrier.resolve();
  await subscription.ready;
  expect(main).toHaveLength(2);
  expect(operations(main.slice(0, 1))).toContainEqual({ action: "update", target: runtime.targets.transcript });
  expect(operations(main.slice(1))).toEqual([{ action: "append", target: runtime.targets.transcript }]);
  expect(main.some((payload) => payload.includes("private_during_snapshot"))).toBe(false);
  subscription.unsubscribe(); await runtime.dispose();
});

test("runtime validates branch and turn membership, cancelling obsolete subscriptions", async () => {
  const runtime = new Runtime();
  runtime.begin();
  let deliveries = 0;
  const listener = () => { deliveries++; };
  expect(() => runtime.subscribeTurnPresentation("foreign:working", "session:branch", listener)).toThrow("Unknown turn");
  expect(() => runtime.subscribeTurnPresentation("entry:working", "other-session:branch", listener)).toThrow("obsolete branch");
  expect(deliveries).toBe(0);
  const first = runtime.subscribeTurnPresentation("entry:working", "session:branch", listener);
  await first.ready;
  expect(runtime.subscribers).toBe(1);
  runtime.branch("session:other");
  expect(runtime.subscribers).toBe(0);
  const count = deliveries;
  runtime.text("obsolete_branch_activity"); runtime.endText();
  expect(deliveries).toBe(count);
  expect(() => runtime.subscribeTurnPresentation("entry:working", "session:branch", listener)).toThrow("obsolete branch");
  const current = runtime.subscribeTurnPresentation("entry:working", "session:other", listener);
  await current.ready;
  first.unsubscribe();
  expect(runtime.subscribers).toBe(1);
  current.unsubscribe();
  expect(runtime.subscribers).toBe(0);
  await runtime.dispose();
});

test("completed history and reconnect snapshots never deliver folded turn payload", async () => {
  const runtime = new Runtime();
  runtime.history = [
    { type: "working", key: "persisted:working", startedAt: 1, completedAt: 4, items: [
      { type: "text", key: "persisted:text", text: "private_persisted_text", final: false },
      { type: "thinking", key: "persisted:thinking", text: "private_persisted_thinking" },
      { type: "tool", key: "persisted:tool", tool: { callId: "saved-call", name: "read", args: {}, status: "ok", resultText: "private_persisted_tool" } },
    ] },
    { type: "text", key: "persisted:final", final: true, text: "public_persisted_final" },
  ];
  for (let reconnect = 0; reconnect < 3; reconnect++) {
    const deliveries: string[] = [];
    const subscription = runtime.subscribeLivePresentation((payload) => deliveries.push(payload));
    await subscription.ready;
    expect(deliveries).toHaveLength(1);
    expect(deliveries.some((payload) => payload.includes("private_persisted"))).toBe(false);
    expect(runtime.subscribers).toBe(0);
    subscription.unsubscribe();
  }
  let delivered = 0;
  const turn = runtime.subscribeTurnPresentation("persisted:working", "session:branch", () => { delivered++; });
  await turn.ready;
  expect(delivered).toBe(1);
  turn.unsubscribe();
  await runtime.dispose();
});

test("closing a turn before capture cancels readiness and reopening receives only current state", async () => {
  const runtime = new Runtime();
  runtime.begin();
  let obsolete = 0;
  const first = runtime.subscribeTurnPresentation("entry:working", "session:branch", () => { obsolete++; });
  first.unsubscribe();
  runtime.text("promoted_before_reopen");
  runtime.final("promoted_before_reopen");
  const deliveries: string[] = [];
  const current = runtime.subscribeTurnPresentation("entry:working", "session:branch", (payload) => deliveries.push(payload));
  await Promise.all([first.ready, current.ready]);
  expect(obsolete).toBe(0);
  expect(deliveries).toHaveLength(1);
  expect(deliveries.some((payload) => payload.includes("promoted_before_reopen"))).toBe(false);
  current.unsubscribe();
  await runtime.dispose();
});

test("an opened turn gets authoritative state before interleaved final removal", async () => {
  const runtime = new Runtime();
  runtime.begin();
  runtime.text("pending_final");
  const deliveries: string[] = [];
  const turn = runtime.subscribeTurnPresentation("entry:working", "session:branch", (payload) => deliveries.push(payload));
  await turn.ready;
  runtime.final("pending_final");
  const routed = operations(deliveries);
  expect(routed[0]).toEqual({ action: "update", target: runtime.targets.turn });
  expect(routed.at(-1)).toEqual({ action: "remove", target: runtime.targets.text });
  turn.unsubscribe();
  await runtime.dispose();
});


test("a persisted task start is overlaid by its live turn rather than replaying stale activity", async () => {
  const runtime = new Runtime();
  runtime.history = [{ type: "working", key: "entry:working", startedAt: 1, items: [{ type: "thinking", key: "old", text: "stale_task_activity" }] }];
  runtime.beginTask();
  runtime.thinking("current_task_activity");
  const deliveries: string[] = [];
  const subscription = runtime.subscribeTurnPresentation("entry:working", "session:branch", (payload) => deliveries.push(payload));
  await subscription.ready;
  expect(deliveries.join("")).toContain("current_task_activity");
  expect(deliveries.join("")).not.toContain("stale_task_activity");
  subscription.unsubscribe();
  await runtime.dispose();
});
