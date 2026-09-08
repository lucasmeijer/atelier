import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAtelierEventBus } from "@atelier/core";
import { RealAgentRuntime } from "../../src/server/real-agent-runtime.ts";
import { AgentServiceTierState } from "../../src/server/service-tier.ts";
import { turnTimingEntryType } from "../../src/server/turn-timing.ts";
import { findTranscriptItem } from "../../src/server/transcript.ts";
import { currentNotificationTurn } from "../../src/server/turn-notifications.ts";

class PersistedRuntime extends RealAgentRuntime {
  protected override async statsView() {
    return { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0,
      modelName: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] };
  }
  liveItems() { return this.live ? this.liveItemsForDisplay(this.live) : []; }
  history() { return this.canonicalItems(); }
  subscribeTurn(listener: (payload: string) => void) {
    return this.subscribeTurnPresentation(this.live!.working.key, this.ctx.branchId!, listener);
  }
}

function harness() {
  // Real Pi storage is important: omitted timing persistence hid an invalid
  // agent_end -> completed-run guard in the old lifecycle mocks.
  const manager = SessionManager.inMemory("/work");
  const startId = manager.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
  let listener!: (event: any) => void;
  const session = {
    sessionManager: manager, isStreaming: false, systemPrompt: "", model: undefined,
    modelRuntime: { getModel: () => undefined },
    subscribe(next: (event: any) => void) { listener = next; return () => {}; },
    async abort() { session.isStreaming = false; },
  };
  const events = createAtelierEventBus();
  let finished = 0;
  events.on("workspace_agent_turn_finished", () => { finished++; });
  const runtime = new PersistedRuntime({ workspaceId: "persisted-lifecycle", conversationId: crypto.randomUUID(),
    label: "Agent", title: "Persisted", path: "/unused.jsonl" }, session, [], new AgentServiceTierState(manager), { events });
  return {
    manager, runtime, startId, finished: () => finished,
    timings: () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === turnTimingEntryType),
    async emit(event: any) {
      if (event.type === "agent_start") session.isStreaming = true;
      if (event.type === "agent_settled") session.isStreaming = false;
      listener(event);
      // Match Pi: listeners run before message persistence; completion summaries
      // and run markers appended by the runtime also go into this same tree.
      if (event.type === "message_end") manager.appendMessage(event.message);
      await Bun.sleep(0);
    },
  };
}

function assistant(stopReason: "stop" | "error" | "toolUse", content: any[], output = 2) {
  return { role: "assistant", api: "openai-responses", provider: "openai", model: "test", timestamp: Date.now(),
    content, stopReason, errorMessage: stopReason === "error" ? "Context window exceeded" : undefined,
    usage: { input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("overflow continues the persisted run despite agent_end.willRetry=false", async () => {
  const h = harness();
  await h.emit({ type: "agent_start" });
  const notification = currentNotificationTurn(h.runtime);
  const deliveries: string[] = [];
  const subscription = h.runtime.subscribeTurn((payload) => deliveries.push(payload));
  await subscription.ready;
  await h.emit({ type: "turn_start" });
  await h.emit({ type: "message_start", message: { role: "assistant" } });
  await h.emit({ type: "message_end", message: assistant("error", []) });
  await h.emit({ type: "agent_end", willRetry: false });
  expect(h.timings()).toEqual([]);
  expect(h.finished()).toBe(0);
  expect(h.runtime.isStreaming).toBe(true);
  await h.emit({ type: "compaction_start", reason: "overflow" });
  h.manager.appendCompaction("Compacted context", h.startId, 10000);
  await h.emit({ type: "compaction_end", reason: "overflow", result: { estimatedTokensAfter: 100 }, willRetry: true });
  await h.emit({ type: "agent_start" });
  expect(currentNotificationTurn(h.runtime)).toEqual(notification);
  expect(h.runtime.liveItems().filter((item) => item.type === "working").map((item) => item.key)).toEqual([`${h.startId}:working`]);
  const before = deliveries.length;
  await h.emit({ type: "turn_start" });
  await h.emit({ type: "message_start", message: { role: "assistant" } });
  await h.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Recovered inference" } });
  expect(deliveries.length).toBeGreaterThan(before);
  await h.emit({ type: "message_end", message: assistant("stop", [{ type: "text", text: "Recovered" }], 3) });
  await h.emit({ type: "agent_end", willRetry: false });
  expect(h.timings()).toEqual([]);
  await h.emit({ type: "agent_settled" });
  expect(h.timings()).toHaveLength(1);
  expect(h.timings()[0]).toMatchObject({ data: { turnEntryId: h.startId, outcome: "completed", outputTokens: 5 } });
  expect(h.finished()).toBe(1);
  expect(h.runtime.liveItems()).toEqual([]);
  expect(h.runtime.history().filter((item) => item.type === "working").map((item) => item.key)).toEqual([`${h.startId}:working`]);
  subscription.unsubscribe();
  await h.runtime.dispose();
});

for (const aborted of [false, true]) {
  test(`overflow compaction ${aborted ? "cancellation" : "failure"} finishes only when Pi settles`, async () => {
    const h = harness();
    await h.emit({ type: "agent_start" });
    await h.emit({ type: "message_end", message: assistant("error", []) });
    await h.emit({ type: "agent_end", willRetry: false });
    await h.emit({ type: "compaction_start", reason: "overflow" });
    await h.emit({ type: "compaction_end", reason: "overflow", aborted, willRetry: false,
      errorMessage: aborted ? undefined : "Compaction failed" });
    expect(h.timings()).toEqual([]);
    expect(h.finished()).toBe(0);
    await h.emit({ type: "agent_settled" });
    expect(h.timings()).toHaveLength(1);
    expect(h.timings()[0]).toMatchObject({ data: { turnEntryId: h.startId, outcome: "stopped" } });
    expect(h.finished()).toBe(1);
    expect(h.runtime.history().find((item) => item.type === "error")).toMatchObject({ text: "Context window exceeded" });
    await h.runtime.dispose();
  });
}

test("streamed tool identity remains resolvable when live state is discarded", async () => {
  const h = harness();
  await h.emit({ type: "agent_start" });
  await h.emit({ type: "message_start", message: { role: "assistant" } });
  const toolCall = { type: "toolCall", id: "call1", name: "read", arguments: { path: "/file" } };
  await h.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0,
    partial: { content: [{ type: "toolCall", name: "read" }] } } });
  const provisional = h.runtime.liveItems().flatMap((item) => item.type === "working" ? item.items : []).find((item) => item.type === "tool")!.key;
  await h.emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCall } });
  const liveTool = h.runtime.liveItems().flatMap((item) => item.type === "working" ? item.items : []).find((item) => item.type === "tool")!;
  expect(liveTool.key).toBe("tool:call1");
  expect(liveTool.key).not.toBe(provisional);
  await h.emit({ type: "message_end", message: assistant("toolUse", [toolCall]) });
  await h.emit({ type: "tool_execution_end", toolCallId: "call1", isError: false, result: { content: [{ type: "text", text: "Tool result" }] } });
  await h.emit({ type: "message_end", message: { role: "toolResult", toolCallId: "call1", toolName: "read",
    content: [{ type: "text", text: "Tool result" }], isError: false, timestamp: Date.now() } });
  await h.emit({ type: "agent_end", willRetry: false });
  await h.emit({ type: "agent_settled" });
  expect(h.runtime.liveItems()).toEqual([]);
  const persisted = findTranscriptItem(h.runtime.history(), liveTool.key);
  expect(persisted).toMatchObject({ type: "tool", key: liveTool.key, tool: { callId: "call1", resultText: "Tool result" } });
  expect(findTranscriptItem(h.runtime.history(), provisional)).toBeUndefined();
  await h.runtime.dispose();
});
