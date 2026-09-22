import { expect, test } from "bun:test";
import { BaseAgentRuntime } from "../../src/server/base-agent-runtime.ts";
import type { AgentStatsView } from "../../src/server/render-composer.ts";
import { commentaryContext, ids } from "../../src/server/render-context.ts";
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
  transientNotice(level: "info" | "error", text: string) { this.notice(level, text); }
  failure(text: string) { this.liveNote(text, "error"); }
  finish() { this.finishLivePresentation("completed"); }
  branch(id: string) { this.resetTurnSubscriptions(id); }
  get subscribers() { return this.turnSubscriberCount; }
  get targets() {
    const commentary = commentaryContext(this.ctx);
    return {
      transcript: ids.transcript(this.ctx),
      turn: ids.workingItems(this.ctx, "entry:working"),
      text: ids.item(this.ctx, "entry:1:text"),
      commentary: ids.workingItems(commentary, "entry:working"),
      commentaryText: ids.item(commentary, "entry:1:text"),
    };
  }
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

test("runtime validates branch and turn membership, cancelling obsolete subscriptions", async () => {
  const runtime = new Runtime();
  runtime.begin();
  let deliveries = 0;
  const listener = () => { deliveries++; };
  expect(() => runtime.subscribeTurnPresentation("foreign:working", "session:branch", listener)).toThrow("Unknown turn");
  expect(() => runtime.subscribeTurnPresentation("entry:working", "other-session:branch", listener)).toThrow("obsolete branch");
  expect(deliveries).toBe(0);
  const first = runtime.subscribeTurnPresentation("entry:working", "session:branch", listener);

  expect(runtime.subscribers).toBe(1);
  runtime.branch("session:other");
  expect(runtime.subscribers).toBe(0);
  const count = deliveries;
  runtime.text("obsolete_branch_activity"); runtime.endText();
  expect(deliveries).toBe(count);
  expect(() => runtime.subscribeTurnPresentation("entry:working", "session:branch", listener)).toThrow("obsolete branch");
  const current = runtime.subscribeTurnPresentation("entry:working", "session:other", listener);

  first.unsubscribe();
  expect(runtime.subscribers).toBe(1);
  current.unsubscribe();
  expect(runtime.subscribers).toBe(0);
  await runtime.dispose();
});

test("completed history and reconnect snapshots include commentary but keep tools and thinking lazy", async () => {
  const runtime = new Runtime();
  runtime.history = [
    { type: "working", key: "persisted:working", startedAt: 1, completedAt: 4, items: [
      { type: "text", key: "persisted:text", text: "persisted_commentary", final: false },
      { type: "thinking", key: "persisted:thinking", text: "private_persisted_thinking" },
      { type: "tool", key: "persisted:tool", tool: { callId: "saved-call", name: "read", args: { path: "private_persisted_path" }, status: "ok", resultText: "private_persisted_tool" } },
    ] },
    { type: "text", key: "persisted:final", final: true, text: "public_persisted_final" },
  ];
  for (let reconnect = 0; reconnect < 3; reconnect++) {
    const deliveries: string[] = [];
    const subscription = runtime.subscribeLivePresentation((payload) => deliveries.push(payload));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain("persisted_commentary");
    expect(deliveries[0]).toContain("public_persisted_final");
    expect(deliveries.some((payload) => payload.includes("private_persisted"))).toBe(false);
    expect(runtime.subscribers).toBe(0);
    subscription.unsubscribe();
  }
  const inner: string[] = [];
  const turn = runtime.subscribeTurnPresentation("persisted:working", "session:branch", (payload) => inner.push(payload));

  expect(inner).toHaveLength(1);
  expect(inner[0]).toContain("persisted_commentary");
  expect(inner[0]).toContain("private_persisted_thinking");
  expect(inner[0]).toContain("private_persisted_path");
  expect(inner[0]).not.toContain("public_persisted_final");
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

  expect(deliveries.join("")).toContain("current_task_activity");
  expect(deliveries.join("")).not.toContain("stale_task_activity");
  subscription.unsubscribe();
  await runtime.dispose();
});

test("notices are delivered once to current subscribers and never replayed by snapshots", async () => {
  const runtime = new Runtime();
  const first: string[] = [];
  const second: string[] = [];
  const a = runtime.subscribeLivePresentation(html => first.push(html));
  const b = runtime.subscribeLivePresentation(html => second.push(html));
  const initialDelivery = [...first];
  expect(initialDelivery).toHaveLength(1);
  expect(second).toEqual(initialDelivery);
  first.length = 0;
  second.length = 0;
  runtime.transientNotice("error", "transient_failure");
  runtime.transientNotice("info", "transient_information");
  expect(first).toEqual(second);
  expect(first).toHaveLength(2);
  a.unsubscribe();
  b.unsubscribe();

  runtime.transientNotice("error", "offline_notice");
  const reconnect: string[] = [];
  const c = runtime.subscribeLivePresentation(html => reconnect.push(html));
  expect(reconnect).toEqual(initialDelivery);
  c.unsubscribe();
  await runtime.dispose();
});

test("notice listeners follow successful subscription lifetimes and disposal", async () => {
  const runtime = new Runtime();
  let failedDeliveries = 0;
  expect(() => runtime.subscribeLivePresentation(() => {
    failedDeliveries++;
    throw new Error("subscription failed");
  })).toThrow("subscription failed");
  runtime.transientNotice("error", "after_failed_subscription");
  expect(failedDeliveries).toBe(1);

  const deliveries: string[] = [];
  const subscription = runtime.subscribeLivePresentation(html => deliveries.push(html));
  subscription.unsubscribe();
  const count = deliveries.length;
  runtime.transientNotice("error", "after_unsubscribe");
  expect(deliveries).toHaveLength(count);

  runtime.subscribeLivePresentation(html => deliveries.push(html));
  const beforeDispose = deliveries.length;
  await runtime.dispose();
  runtime.transientNotice("error", "after_disposal");
  expect(deliveries).toHaveLength(beforeDispose);
});
