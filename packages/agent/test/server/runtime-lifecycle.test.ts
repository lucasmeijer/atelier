import { currentNotificationTurn, setTurnNotification } from "../../src/server/turn-notifications.ts";
import { createAtelierEventBus } from "@atelier/core";
import { expect, test } from "bun:test";
import { RealAgentRuntime } from "../../src/server/real-agent-runtime.ts";
import type { AgentStatsView } from "../../src/server/render-composer.ts";
import { AgentServiceTierState } from "../../src/server/service-tier.ts";
import { subscribeWorkspaceViewBusy } from "../../src/server/workspace-view-busy.ts";
import { turnTimingEntryType } from "../../src/server/turn-timing.ts";
import { buildTranscript, type TranscriptItem } from "../../src/server/transcript.ts";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type SessionListener = (event: any) => void;
type ToolStreamEvent =
  | { type: "toolcall_start"; contentIndex: number; partial: { content: Array<{ name: string }> } }
  | { type: "toolcall_delta"; delta: string }
  | { type: "toolcall_end"; toolCall: { id: string; name: string; arguments: { path: string; content: string } } };

interface FakeSessionHarness {
  session: any;
  emit(event: any): void;
  emitStale(event: any): void;
  abortCount(): number;
  unsubscribeCount(): number;
}

function fakeSession(navigation: Deferred<{ editorText?: string; cancelled?: boolean; aborted?: boolean }>): FakeSessionHarness {
  let listener: SessionListener | undefined;
  let staleListener: SessionListener | undefined;
  let aborts = 0;
  let unsubscribes = 0;
  const entries = new Map([
    ["entry", { id: "entry", parentId: "parent" }],
    ["parent", { id: "parent", parentId: null }],
  ]);
  const session = {
    isStreaming: false,
    model: undefined,
    systemPrompt: "",
    modelRuntime: { getModel: () => undefined },
    sessionManager: {
      appendCustomEntry: () => crypto.randomUUID(),
      getSessionId: () => "test-session",
      getLeafId: () => "initial-user",
      getBranch: () => [{ type: "message", id: "initial-user", parentId: "parent", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Initial prompt" }] } }],
      getEntry: (entryId: string) => entries.get(entryId),
    },
    subscribe(next: SessionListener): () => void {
      listener = next;
      staleListener = next;
      return () => {
        unsubscribes += 1;
        listener = undefined;
      };
    },
    async abort() {
      aborts += 1;
      session.isStreaming = false;
    },
    async waitForIdle() {},
    navigateTree: () => navigation.promise,
    abortBranchSummary: () => navigation.resolve({ cancelled: true, aborted: true }),
  };
  return {
    session,
    emit: (event) => listener?.(event),
    emitStale: (event) => staleListener?.(event),
    abortCount: () => aborts,
    unsubscribeCount: () => unsubscribes,
  };
}

const emptyStats: AgentStatsView = {
  contextPercent: null,
  compactAvailable: false,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  modelName: undefined,
  thinkingLevel: "off",
  thinkingLevels: [],
  models: [],
};

class InspectableAgentRuntime extends RealAgentRuntime {
  private readonly statsCompletions: Array<() => Promise<void>> = [];
  readonly notes: Array<{ text: string; tone: string }> = [];

  protected override liveNote(text: string, tone: "system" | "summary" | "error"): void {
    this.notes.push({ text, tone });
    super.liveNote(text, tone);
  }

  readonly toolContentUpdates: Array<{ prefix?: string; status: string }> = [];

  protected override streamActiveToolContent(item: Extract<TranscriptItem, { type: "tool" }>): void {
    this.toolContentUpdates.push({ prefix: item.tool.argsStream, status: item.tool.status });
    super.streamActiveToolContent(item);
  }

  protected override canonicalItems(_leafId?: string): TranscriptItem[] {
    return [];
  }

  protected override async statsView(): Promise<AgentStatsView> {
    await this.statsCompletions.shift()?.();
    return emptyStats;
  }

  queueStatsCompletion(completion: () => Promise<void>): void {
    this.statsCompletions.push(completion);
  }

  async refreshStatsForTest(): Promise<void> {
    await this.refreshStats();
  }

  inspectLiveItems(): TranscriptItem[] {
    return this.live ? this.liveItemsForDisplay(this.live) : [];
  }

  inspectBranchId(): string { return this.ctx.branchId!; }

  subscribeCurrentTurn(listener: (html: string) => void) {
    return this.subscribeTurnPresentation(this.live!.working.key, this.ctx.branchId!, listener);
  }

  inspectLiveSubscriberCount(): number {
    return this.liveSubscriberCount;
  }
}

function runtimeFor(session: any, events = createAtelierEventBus()): InspectableAgentRuntime {
  return new InspectableAgentRuntime(
    {
      workspaceId: "runtime-lifecycle-workspace",
      conversationId: "53fc77b7-dc19-42d5-b200-2e134ec67529",
      label: "Agent 1",
      title: "Lifecycle",
      path: "/tmp/runtime-lifecycle.jsonl",
    },
    session,
    [],
    new AgentServiceTierState(session.sessionManager),
    { events },
  );
}

test("tool deltas update authoritative state immediately and coalesce server publications", async () => {
  const { session, emit } = fakeSession(deferred());
  const runtime = runtimeFor(session);
  const subscription = runtime.subscribeLivePresentation(() => {});
  await subscription.ready;
  const event = (inner: ToolStreamEvent) => emit({ type: "message_update", assistantMessageEvent: inner });
  emit({ type: "agent_start" });
  const innerSubscription = runtime.subscribeCurrentTurn(() => {});
  await innerSubscription.ready;
  event({ type: "toolcall_start", contentIndex: 0, partial: { content: [{ name: "write" }] } });
  const args = { path: "coalescing.js", content: "const n = 42;" };
  const json = JSON.stringify(args);
  for (const delta of json) event({ type: "toolcall_delta", delta });
  const item = runtime.inspectLiveItems().flatMap((item) => item.type === "working" ? item.items : [item]).find((item) => item.type === "tool");
  expect(item?.type === "tool" && item.tool.argsStream).toBe(json);
  expect(runtime.toolContentUpdates).toHaveLength(0);
  await Bun.sleep(70);
  expect(runtime.toolContentUpdates).toEqual([{ prefix: json, status: "streaming" }]);
  event({ type: "toolcall_delta", delta: " " });
  event({ type: "toolcall_end", toolCall: { id: "call", name: "write", arguments: args } });
  expect(item?.type === "tool" && item.tool.status).toBe("running");
  const count = runtime.toolContentUpdates.length;
  await Bun.sleep(70);
  expect(runtime.toolContentUpdates).toHaveLength(count);
  innerSubscription.unsubscribe();
  subscription.unsubscribe();
});

test("large tool arguments slow publications to 500 ms without delaying state or completion", async () => {
  const { session, emit } = fakeSession(deferred());
  const runtime = runtimeFor(session);
  const subscription = runtime.subscribeLivePresentation(() => {});
  await subscription.ready;
  const event = (inner: ToolStreamEvent) => emit({ type: "message_update", assistantMessageEvent: inner });
  emit({ type: "agent_start" });
  const innerSubscription = runtime.subscribeCurrentTurn(() => {});
  await innerSubscription.ready;
  event({ type: "toolcall_start", contentIndex: 0, partial: { content: [{ name: "write" }] } });
  // Exactly 2 KiB in UTF-8, but fewer than 2,048 UTF-16 code units.
  const prefix = '{"content":"' + "é".repeat(1018);
  expect(Buffer.byteLength(prefix)).toBe(2048);
  event({ type: "toolcall_delta", delta: prefix.slice(0, -1) });
  await Bun.sleep(70);
  expect(runtime.toolContentUpdates).toHaveLength(1);
  event({ type: "toolcall_delta", delta: "é" });
  await Bun.sleep(100);
  expect(runtime.toolContentUpdates).toHaveLength(1);
  event({ type: "toolcall_delta", delta: "more" });
  const item = runtime.inspectLiveItems().flatMap((item) => item.type === "working" ? item.items : [item]).find((item) => item.type === "tool");
  expect(item?.type === "tool" && item.tool.argsStream).toBe(prefix + "more");
  await Bun.sleep(450);
  expect(runtime.toolContentUpdates).toHaveLength(2);
  expect(runtime.toolContentUpdates.at(-1)?.prefix).toBe(prefix + "more");
  event({ type: "toolcall_delta", delta: '"}' });
  event({ type: "toolcall_end", toolCall: { id: "large", name: "write", arguments: { path: "large.txt", content: "é".repeat(1018) + "more" } } });
  expect(item?.type === "tool" && item.tool.status).toBe("running");
  const count = runtime.toolContentUpdates.length;
  await Bun.sleep(550);
  expect(runtime.toolContentUpdates).toHaveLength(count);
  // A later small call gets the fast cadence again.
  event({ type: "toolcall_start", contentIndex: 1, partial: { content: [{ name: "write" }, { name: "write" }] } });
  event({ type: "toolcall_delta", delta: '{"content":"small' });
  await Bun.sleep(70);
  expect(runtime.toolContentUpdates).toHaveLength(count + 1);
  innerSubscription.unsubscribe();
  subscription.unsubscribe();
});

test("pending tool updates stop when the last subscriber leaves", async () => {
  const { session, emit } = fakeSession(deferred());
  const runtime = runtimeFor(session);
  const subscription = runtime.subscribeLivePresentation(() => {});
  await subscription.ready;
  emit({ type: "agent_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: { content: [{ name: "write" }] } } });
  emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: '{"path":"file.js"' } });
  subscription.unsubscribe();
  await Bun.sleep(70);
  expect(runtime.toolContentUpdates).toHaveLength(0);
});

test("awaited tree summarization leaves busy and emits one terminal event when navigation fails", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  const busy: boolean[] = [];
  let finished = 0;
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => {
    finished += 1;
  });

  try {
    const navigating = runtime.navigateTree("entry", { summarize: true });
    expect(runtime.isStreaming).toBe(true);
    expect(busy).toEqual([true]);

    navigation.reject(new Error("summary failed"));
    await expect(navigating).rejects.toThrow("summary failed");

    expect(runtime.isStreaming).toBe(false);
    expect(busy).toEqual([true, false]);
    expect(finished).toBe(1);
    expect(currentNotificationTurn(runtime)).toBeUndefined();
  } finally {
    unsubscribeBusy();
  }
});

test("detached rewind summarization marks a hidden Agent ready exactly once", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  const busy: boolean[] = [];
  let hidden = false;
  let unread = false;
  let finished = 0;
  const terminal = deferred<void>();
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => {
    finished += 1;
    if (hidden) unread = true;
    terminal.resolve();
  });

  try {
    await runtime.rewind("entry", "summary");
    expect(runtime.isStreaming).toBe(true);
    expect(busy).toEqual([true]);

    hidden = true;
    navigation.resolve({});
    await terminal.promise;

    expect(runtime.isStreaming).toBe(false);
    expect(busy).toEqual([true, false]);
    expect(unread).toBe(true);
    expect(finished).toBe(1);
  } finally {
    unsubscribeBusy();
  }
});

test("aborting detached rewind summarization waits for terminal cleanup", async () => {
  const navigation = deferred<{ cancelled?: boolean; aborted?: boolean }>();
  const { session } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  let finished = 0;
  const terminal = deferred<void>();
  events.on("workspace_agent_turn_finished", () => {
    finished += 1;
    terminal.resolve();
  });

  await runtime.rewind("entry", "summary");
  await runtime.abort();
  await terminal.promise;

  expect(runtime.isStreaming).toBe(false);
  expect(finished).toBe(1);
});

test("disposing a busy closed Agent unsubscribes and suppresses delayed terminal readiness", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit, emitStale, abortCount, unsubscribeCount } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  const busy: boolean[] = [];
  let finished = 0;
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => {
    finished += 1;
  });

  try {
    emit({ type: "agent_start" });
    const turn = currentNotificationTurn(runtime)!;
    setTurnNotification(runtime, turn.id, { endpoint: "https://web.push.apple.com/disposed", keys: { p256dh: "unused", auth: "unused" } });
    await runtime.dispose();
    expect(currentNotificationTurn(runtime)).toBeUndefined();
    expect(setTurnNotification(runtime, turn.id, undefined)).toBe(false);
    emitStale({ type: "agent_end" });
    await Bun.sleep(0);

    expect(unsubscribeCount()).toBe(1);
    expect(abortCount()).toBe(1);
    expect(busy).toEqual([true, false]);
    expect(finished).toBe(0);
    expect(() => runtime.userMessages()).toThrow("Agent conversation not found");
  } finally {
    unsubscribeBusy();
  }
});

test("dispose cancels and joins detached rewind summarization without publishing readiness", async () => {
  const navigation = deferred<{ editorText?: string; cancelled?: boolean; aborted?: boolean }>();
  const { session, unsubscribeCount } = fakeSession(navigation);
  let summaryAborts = 0;
  session.abortBranchSummary = () => {
    summaryAborts += 1;
  };
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  const busy: boolean[] = [];
  let finished = 0;
  let disposed = false;
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => { finished += 1; });

  try {
    await runtime.rewind("entry", "summary");
    const disposal = runtime.dispose();
    expect(runtime.dispose()).toBe(disposal);
    const disposing = disposal.then(() => { disposed = true; });
    await Bun.sleep(0);

    expect(summaryAborts).toBe(1);
    expect(disposed).toBe(false);
    expect(unsubscribeCount()).toBe(1);
    expect(finished).toBe(0);

    navigation.resolve({ cancelled: true, aborted: true });
    await disposing;

    expect(disposed).toBe(true);
    expect(busy).toEqual([true, false]);
    expect(finished).toBe(0);
  } finally {
    unsubscribeBusy();
  }
});

test("dispose signals compaction cancellation and waits for the session operation to settle", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, abortCount } = fakeSession(navigation);
  const compaction = deferred<void>();
  let compactionAborts = 0;
  session.isCompacting = true;
  session.compact = () => compaction.promise.finally(() => {
    session.isCompacting = false;
  });
  session.abortCompaction = () => {
    compactionAborts += 1;
  };
  const runtime = runtimeFor(session);

  const compacting = runtime.compact();
  let disposed = false;
  const disposing = runtime.dispose().then(() => { disposed = true; });
  await Bun.sleep(0);

  expect(compactionAborts).toBe(1);
  expect(abortCount()).toBe(0);
  expect(disposed).toBe(false);

  compaction.resolve();
  await Promise.all([compacting, disposing]);
  expect(disposed).toBe(true);
});

test("retry boundaries remain continuously busy and only the settled prompt becomes ready", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  const busy: boolean[] = [];
  let finished = 0;
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => { finished += 1; });

  try {
    emit({ type: "agent_start" });
    const notificationTurn = currentNotificationTurn(runtime);
    expect(notificationTurn).toBeDefined();
    emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Temporary provider failure" } });
    emit({ type: "agent_end", willRetry: true });
    await Bun.sleep(0);
    expect(busy).toEqual([true]);
    expect(finished).toBe(0);
    expect(currentNotificationTurn(runtime)).toEqual(notificationTurn);

    emit({ type: "agent_start" });
    expect(currentNotificationTurn(runtime)).toEqual(notificationTurn);
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    await Bun.sleep(0);
    expect(busy).toEqual([true, false]);
    expect(finished).toBe(1);
    expect(currentNotificationTurn(runtime)).toBeUndefined();
  } finally {
    unsubscribeBusy();
  }
});

test("threshold compaction inside an Agent loop stays busy until the prompt settles", async () => {
  const { session, emit } = fakeSession(deferred<{ editorText?: string }>());
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  const busy: boolean[] = [];
  let finished = 0;
  const unsubscribe = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => { finished += 1; });

  try {
    session.isStreaming = true;
    emit({ type: "agent_start" });
    emit({ type: "compaction_start", reason: "threshold" });
    emit({ type: "compaction_end", reason: "threshold", willRetry: false });
    await Bun.sleep(0);
    expect(runtime.isStreaming).toBe(true);
    expect(busy).toEqual([true]);
    expect(finished).toBe(0);

    // Inference resumes in the existing loop, without another agent_start.
    emit({ type: "turn_start" });
    expect(busy).toEqual([true]);
    emit({ type: "agent_end", willRetry: false });
    await Bun.sleep(0);
    expect(busy).toEqual([true]);
    expect(finished).toBe(0);

    // Pi can also compact after the loop, before settling its outer prompt.
    emit({ type: "compaction_start", reason: "threshold" });
    emit({ type: "compaction_end", reason: "threshold", willRetry: false });
    await Bun.sleep(0);
    expect(busy).toEqual([true]);
    expect(finished).toBe(0);
    session.isStreaming = false;
    emit({ type: "agent_settled" });
    await Bun.sleep(0);
    expect(busy).toEqual([true, false]);
    expect(finished).toBe(1);
    expect(currentNotificationTurn(runtime)).toBeUndefined();
  } finally {
    unsubscribe();
  }
});

test("a settled prompt becomes ready before stats and cannot clear a newer run", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  const releaseOldStats = deferred<void>();
  runtime.queueStatsCompletion(() => releaseOldStats.promise);
  const busy: boolean[] = [];
  let finished = 0;
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => { finished += 1; });

  try {
    emit({ type: "agent_start" });
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    await Bun.sleep(0);

    expect(busy).toEqual([true, false]);
    expect(finished).toBe(1);
    expect(currentNotificationTurn(runtime)).toBeUndefined();

    emit({ type: "agent_start" });
    releaseOldStats.resolve();
    await Bun.sleep(0);

    expect(busy).toEqual([true, false, true]);
    expect(finished).toBe(1);
  } finally {
    unsubscribeBusy();
  }
});

test("throwing terminal stats do not suppress idle state or readiness", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  runtime.queueStatsCompletion(async () => { throw new Error("stats unavailable"); });
  const busy: boolean[] = [];
  let finished = 0;
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });
  events.on("workspace_agent_turn_finished", () => { finished += 1; });

  try {
    emit({ type: "agent_start" });
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    await Bun.sleep(0);

    expect(busy).toEqual([true, false]);
    expect(finished).toBe(1);
    expect(currentNotificationTurn(runtime)).toBeUndefined();
  } finally {
    unsubscribeBusy();
  }
});

test("abort succeeds even when its secondary stats refresh fails", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const runtime = runtimeFor(session);
  runtime.queueStatsCompletion(async () => { throw new Error("stats unavailable after abort"); });
  const busy: boolean[] = [];
  const unsubscribeBusy = subscribeWorkspaceViewBusy((event) => {
    if (event.workspaceId === runtime.workspaceId && event.viewKey === `agent:${runtime.conversationId}`) busy.push(event.busy);
  });

  try {
    emit({ type: "agent_start" });
    await expect(runtime.abort()).resolves.toBeUndefined();
    await Bun.sleep(0);

    expect(busy).toEqual([true, false]);
  } finally {
    unsubscribeBusy();
  }
});

test.each([
  ["success", {}],
  ["final failure", { error: new Error("provider failed") }],
  ["user abort", { aborted: true }],
] as const)("%s settled prompt emits one terminal readiness", async (_name, terminalEvent) => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  let finished = 0;
  events.on("workspace_agent_turn_finished", () => { finished += 1; });

  emit({ type: "agent_start" });
  emit({ type: "agent_end", willRetry: false, ...terminalEvent });
  emit({ type: "agent_settled" });
  await Bun.sleep(0);

  expect(finished).toBe(1);
});

test("submit resolves at Pi preflight acceptance while the turn continues asynchronously", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const turn = deferred<void>();
  session.prompt = (_text: string, options: { preflightResult(success: boolean): void }) => {
    options.preflightResult(true);
    emit({ type: "agent_start" });
    return turn.promise;
  };
  const runtime = runtimeFor(session);

  await runtime.submit("Accepted");

  expect(runtime.inspectLiveItems()).toEqual([]);
  turn.resolve();
});

test("an accepted handled command without an Agent run never leaves speculative busy UI", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session } = fakeSession(navigation);
  session.prompt = async (_text: string, options: { preflightResult(success: boolean): void }) => {
    options.preflightResult(true);
  };
  const runtime = runtimeFor(session);

  await runtime.submit("/handled");
  await Bun.sleep(0);

  expect(runtime.isStreaming).toBe(false);
  expect(runtime.inspectLiveItems()).toEqual([]);
});

test("submit rejects failed Pi preflight without emitting terminal readiness", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session } = fakeSession(navigation);
  session.prompt = async (_text: string, options: { preflightResult(success: boolean): void }) => {
    options.preflightResult(false);
    throw new Error("model authentication unavailable");
  };
  const events = createAtelierEventBus();
  const runtime = runtimeFor(session, events);
  let finished = 0;
  events.on("workspace_agent_turn_finished", () => { finished += 1; });

  await expect(runtime.submit("Rejected")).rejects.toThrow("model authentication unavailable");

  expect(runtime.inspectLiveItems()).toEqual([]);
  expect(finished).toBe(0);
});

test("live Responses text events keep commentary in Working and render only final_answer outside", () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const runtime = runtimeFor(session);
  const commentarySignature = JSON.stringify({ v: 1, id: "message-1", phase: "commentary" });
  const finalSignature = JSON.stringify({ v: 1, id: "message-1", phase: "final_answer" });
  const partial = (content: Array<{ type: string; text: string; textSignature: string }>) => ({ stopReason: "pending", content });
  const commentary = { type: "text", text: "I’m checking that now.", textSignature: commentarySignature };
  const final = { type: "text", text: "Everything is ready.", textSignature: finalSignature };

  emit({ type: "agent_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: partial([{ ...commentary, text: "" }]) } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: commentary.text, partial: partial([commentary]) } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: commentary.text, partial: partial([commentary]) } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: partial([commentary, { ...final, text: "" }]) } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: final.text, partial: partial([commentary, final]) } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: final.text, partial: partial([commentary, final]) } });

  const items = runtime.inspectLiveItems();
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({
    type: "working",
    items: [{ type: "text", text: commentary.text, final: false }],
  });
  expect(items[1]).toMatchObject({ type: "text", text: final.text, final: true });
});

test("a second live subscriber cannot advance pacing past text the first subscriber has not received", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const runtime = runtimeFor(session);
  const firstDeliveries: string[] = [];
  const secondDeliveries: string[] = [];
  const firstSubscription = runtime.subscribeLivePresentation((html) => firstDeliveries.push(html));
  await firstSubscription.ready;
  const text = "paced-text-abcdefghijklmnopqrstuvwxyz-0123456789";
  const partial = { stopReason: "stop", content: [{ type: "text", text }] };

  emit({ type: "agent_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { ...partial, content: [{ type: "text", text: "" }] } } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial } });
  const secondSubscription = runtime.subscribeLivePresentation((html) => secondDeliveries.push(html));
  await secondSubscription.ready;

  expect(firstDeliveries.join("")).toContain(text);
  expect(secondDeliveries[0]).toContain(text);
  expect(firstDeliveries.join("").split(text)).toHaveLength(2);
  expect(secondDeliveries[0]!.split(text)).toHaveLength(2);

  secondSubscription.unsubscribe();
  firstSubscription.unsubscribe();
});

test("cancelling a pending authoritative snapshot releases the runtime subscriber before rendering finishes", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session } = fakeSession(navigation);
  const runtime = runtimeFor(session);
  const snapshotStarted = deferred<void>();
  const releaseSnapshot = deferred<void>();
  runtime.queueStatsCompletion(async () => {
    snapshotStarted.resolve();
    await releaseSnapshot.promise;
  });

  const subscription = runtime.subscribeLivePresentation(() => {});
  await snapshotStarted.promise;
  expect(runtime.inspectLiveSubscriberCount()).toBe(1);

  subscription.unsubscribe();
  expect(runtime.inspectLiveSubscriberCount()).toBe(0);
  try {
    await Promise.race([
      subscription.ready,
      Bun.sleep(100).then(() => { throw new Error("cancelled subscription remained blocked on its snapshot"); }),
    ]);
  } finally {
    releaseSnapshot.resolve();
  }
});

test("a joining snapshot absorbs queued paced text at its actual capture boundary", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const runtime = runtimeFor(session);
  const firstDeliveries: string[] = [];
  const secondDeliveries: string[] = [];
  const releasePredecessor = deferred<void>();
  const releaseSnapshotStats = deferred<void>();
  const firstSubscription = runtime.subscribeLivePresentation((html) => firstDeliveries.push(html));
  await firstSubscription.ready;
  const beforeBoundary = "abcdefghijklmnopqrstuvwxyz-123456789";

  emit({ type: "agent_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { stopReason: "stop", content: [{ type: "text", text: "" }] } } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: beforeBoundary, partial: { stopReason: "stop", content: [{ type: "text", text: beforeBoundary }] } } });

  runtime.queueStatsCompletion(() => releasePredecessor.promise);
  const predecessor = runtime.refreshStatsForTest();
  runtime.queueStatsCompletion(() => releaseSnapshotStats.promise);
  const subscribing = runtime.subscribeLivePresentation((html) => secondDeliveries.push(html));
  await Bun.sleep(70);

  releasePredecessor.resolve();
  await predecessor;
  for (let attempts = 0; attempts < 20 && !firstDeliveries.some((html) => html.includes(beforeBoundary)); attempts += 1) {
    await Bun.sleep(0);
  }

  const deliveriesAtBoundary = firstDeliveries.length;
  expect(firstDeliveries.at(-1)).toContain(beforeBoundary);

  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Z", partial: { stopReason: "stop", content: [{ type: "text", text: `${beforeBoundary}Z` }] } } });
  await Bun.sleep(70);
  expect(firstDeliveries).toHaveLength(deliveriesAtBoundary);

  releaseSnapshotStats.resolve();
  await subscribing.ready;
  await Bun.sleep(0);

  expect(firstDeliveries).toHaveLength(deliveriesAtBoundary + 1);
  expect(secondDeliveries).toHaveLength(2);
  expect(secondDeliveries[0]).toContain(beforeBoundary);
  expect(secondDeliveries[0]).not.toContain(`${beforeBoundary}Z`);
  expect(secondDeliveries[1]).toContain(`${beforeBoundary}Z`);

  subscribing.unsubscribe();
  firstSubscription.unsubscribe();
});

for (const failure of [
  { stopReason: "error", errorMessage: "Expected a provider request object." },
  { stopReason: "error", errorMessage: undefined },
  { stopReason: "aborted", errorMessage: undefined },
  { stopReason: "aborted", errorMessage: "Request cancelled" },
] as const) {
  test(`assistant ${failure.stopReason}: ${failure.errorMessage ?? "no detail"} is published once and agrees with reload`, async () => {
    const { session, emit } = fakeSession(deferred());
    const runtime = runtimeFor(session);
    emit({ type: "agent_start" });
    const message = { role: "assistant", content: [], ...failure };
    emit({ type: "message_update", assistantMessageEvent: { type: "error", error: message }, message });
    emit({ type: "message_end", message });
    expect(runtime.notes).toEqual([]);
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    const reloaded = buildTranscript([{ kind: "assistant", id: "failure", parts: [], timestamp: 1, ...failure }]);
    expect(runtime.notes.filter((item) => item.tone === "error").map((item) => item.text))
      .toEqual(reloaded.filter((item) => item.type === "error").map((item) => item.text));
    expect(runtime.notes.filter((item) => item.tone === "error")).toHaveLength(1);
    expect(runtime.inspectLiveItems()).toEqual([]);
  });
}


test("provider failure preserves streamed partial content as non-final activity", () => {
  const { session, emit } = fakeSession(deferred());
  const runtime = runtimeFor(session);
  emit({ type: "agent_start" });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: { content: [{ type: "text", text: "Partial response" }], stopReason: "pending" }, delta: "Partial response" } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Partial response" }], stopReason: "error", errorMessage: "Connection lost" } });
  const items = runtime.inspectLiveItems().flatMap((item) => item.type === "working" ? item.items : [item]);
  expect(items.filter((item) => item.type === "text").map((item) => ({ text: item.text, final: Boolean(item.final) })))
    .toEqual([{ text: "Partial response", final: false }]);
  expect(items.filter((item) => item.type === "error")).toEqual([]);
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
  expect(runtime.notes).toEqual([{ tone: "error", text: "Connection lost" }]);
});

test("consumed steering keeps the run subscription and publishes only one summary", async () => {
  const { session, emit } = fakeSession(deferred());
  const entries = session.sessionManager.getBranch();
  session.sessionManager.getBranch = () => entries;
  const timings: Array<{ turnEntryId: string; outcome: string }> = [];
  session.sessionManager.appendCustomEntry = (_type: string, timing: { turnEntryId: string; outcome: string }) => {
    if (_type === turnTimingEntryType) timings.push(timing);
    return "timing";
  };
  session.steer = async () => {};
  const runtime = runtimeFor(session);
  emit({ type: "agent_start" });
  const first = runtime.inspectLiveItems().find((item) => item.type === "working")!;
  expect(first.key).toBe("initial-user:working");
  const deliveries: string[] = [];
  const subscription = runtime.subscribeCurrentTurn((payload) => deliveries.push(payload));
  await subscription.ready;
  session.isStreaming = true;
  await runtime.submit("Steer now");
  expect(runtime.inspectLiveItems().find((item) => item.type === "working")!.key).toBe(first.key);
  expect(timings).toEqual([]);
  const user = { role: "user", content: [{ type: "text", text: "Steer now" }] };
  emit({ type: "turn_start" });
  emit({ type: "message_end", message: user });
  // Pi appends after synchronous listener notification, before microtasks run.
  entries.push({ type: "message", id: "steering-pi-id", parentId: "initial-user", message: user });
  await Promise.resolve();
  expect(timings).toEqual([]);
  expect(runtime.inspectLiveItems().filter((item) => item.type === "working").map((item) => item.key)).toEqual([first.key]);
  emit({ type: "message_start", message: { role: "assistant" } });
  const beforeActivity = deliveries.length;
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Still on the same subscription" } });
  expect(deliveries.length).toBeGreaterThan(beforeActivity);
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "After steering" }], stopReason: "stop", usage: { output: 3 } } });
  expect(runtime.inspectLiveItems().map((item) => item.type)).toEqual(["working", "user", "text"]);
  expect(runtime.inspectLiveItems()[1]).toMatchObject({ text: "Steer now", rewindEntryId: "steering-pi-id" });
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
  expect(timings).toHaveLength(1);
  expect(timings[0]).toMatchObject({ turnEntryId: "initial-user", outcome: "completed", usageComplete: true, outputTokens: 3 });
  subscription.unsubscribe();
});

test("automatic retries retain turn identity and publish only one terminal summary", () => {
  const { session, emit } = fakeSession(deferred());
  const timings: Array<{ turnEntryId: string; outputTokens: number }> = [];
  session.sessionManager.appendCustomEntry = (_type: string, timing: { turnEntryId: string; outputTokens: number }) => { if (_type === turnTimingEntryType) timings.push(timing); return "timing"; };
  const runtime = runtimeFor(session);
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [], usage: { output: 2 }, stopReason: "error", errorMessage: "Retry me" } });
  emit({ type: "agent_end", willRetry: true });
  expect(timings).toEqual([]);
  expect(runtime.notes).toEqual([]);
  expect(runtime.inspectLiveItems().find((item) => item.type === "working")!.key).toBe("initial-user:working");
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], usage: { output: 3 }, stopReason: "stop" } });
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
  expect(timings).toHaveLength(1);
  expect(timings[0]).toMatchObject({ turnEntryId: "initial-user", outputTokens: 5, outcome: "completed" });
});

test("accepted prompt does not advertise a temporary turn before Pi persistence", async () => {
  const { session, emit } = fakeSession(deferred());
  const entries: any[] = [];
  session.sessionManager.getBranch = () => entries;
  session.prompt = async (_text: string, options: { preflightResult(success: boolean): void }) => {
    options.preflightResult(true);
    emit({ type: "agent_start" });
  };
  const runtime = runtimeFor(session);
  await runtime.submit("Start");
  expect(runtime.inspectLiveItems()).toEqual([]);
  const user = { role: "user", content: [{ type: "text", text: "Start" }] };
  emit({ type: "message_end", message: user });
  entries.push({ type: "message", id: "permanent-start", parentId: null, message: user });
  await Promise.resolve();
  expect(runtime.inspectLiveItems().find((item) => item.type === "working")!.key).toBe("permanent-start:working");
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
});

test("branch selection rejects obsolete subscriptions even when the turn start is shared", async () => {
  const navigation = deferred<{ editorText?: string }>();
  const { session, emit } = fakeSession(navigation);
  const runtime = runtimeFor(session);
  emit({ type: "agent_start" });
  const oldBranch = runtime.inspectBranchId();
  const deliveries: string[] = [];
  const old = runtime.subscribeCurrentTurn((html) => deliveries.push(html));
  await old.ready;
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
  session.sessionManager.getLeafId = () => "other-branch";
  navigation.resolve({});
  await runtime.navigateTree("other-branch", { summarize: false });
  expect(runtime.inspectBranchId()).not.toBe(oldBranch);
  const count = deliveries.length;
  emit({ type: "agent_start" });
  expect(runtime.inspectLiveItems().find((item) => item.type === "working")!.key).toBe("initial-user:working");
  expect(() => runtime.subscribeTurnPresentation("initial-user:working", oldBranch, () => {})).toThrow("obsolete branch");
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Other branch only" } });
  expect(deliveries).toHaveLength(count);
  old.unsubscribe();
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
});

test("cancelling retry backoff closes the existing block with a stopped summary", async () => {
  const { session, emit } = fakeSession(deferred());
  const timings: Array<{ turnEntryId: string; outcome: string }> = [];
  session.sessionManager.appendCustomEntry = (_type: string, timing: { turnEntryId: string; outcome: string }) => { if (_type === turnTimingEntryType) timings.push(timing); return "timing"; };
  const events = createAtelierEventBus();
  let finished = 0;
  events.on("workspace_agent_turn_finished", () => { finished += 1; });
  const runtime = runtimeFor(session, events);
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Busy" } });
  emit({ type: "agent_end", willRetry: true });
  emit({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
  emit({ type: "agent_settled" });
  await Promise.resolve();
  expect(timings).toHaveLength(1);
  expect(timings[0]).toMatchObject({ turnEntryId: "initial-user", outcome: "stopped" });
  expect(runtime.notes).toEqual([{ tone: "error", text: "Retry cancelled" }]);
  expect(finished).toBe(1);
  expect(runtime.inspectLiveItems()).toEqual([]);
});

test("an early-final answer that fails is demoted to inner non-final activity", () => {
  const { session, emit } = fakeSession(deferred());
  const runtime = runtimeFor(session);
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant" } });
  const text = "Incomplete answer";
  const part = { type: "text", text, textSignature: JSON.stringify({ v: 1, id: "final-id", phase: "final_answer" }) };
  emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: { content: [part], stopReason: "pending" } } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: { content: [part], stopReason: "pending" } } });
  expect(runtime.inspectLiveItems().find((item) => item.type === "text")).toMatchObject({ final: true, text });
  emit({ type: "message_end", message: { role: "assistant", content: [part], stopReason: "error", errorMessage: "Disconnected" } });
  expect(runtime.inspectLiveItems().filter((item) => item.type === "text")).toEqual([]);
  const inner = runtime.inspectLiveItems().find((item) => item.type === "working");
  expect(inner?.type === "working" && inner.items.find((item) => item.type === "text")).toMatchObject({ final: false, text });
  emit({ type: "agent_end", willRetry: false });
  emit({ type: "agent_settled" });
});
