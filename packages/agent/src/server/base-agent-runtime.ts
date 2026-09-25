import { AtelierCoreError, type JsonObject } from "@atelier/core";
import { StreamingMarkdownRenderer } from "@atelier/markdown";
import { createLivePresentation, createPublishedRefresh, turboStream } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { renderWorkspaceCompletionCatalog } from "./completion-catalog.ts";
import { significantCacheMissNotice, type CacheMiss } from "./cache-miss.ts";
import { renderAgentPaneComposerFooter, renderPromptActions, type AgentPaneState, type AgentStatsView } from "./render-composer.ts";
import { ids, type AgentRenderContext } from "./render-context.ts";
import { LiveTranscriptRenderer } from "./render-live-transcript.ts";
import { renderNotice } from "./render-notice.ts";
import { notificationControlId, renderNotificationControl } from "./render-notification.ts";
import {
  renderModelContextDetailFrame,
  renderTranscriptItemDetailFrame,
  type AgentModelContextView
} from "./render-transcript.ts";
import type {
  AgentLivePresentationListener,
  AgentLivePresentationSubscription,
  RewindMode,
  SubmitOptions,
  WorkspaceAgentRuntime,
  WorkspaceAgentRuntimeOptions,
} from "./runtime-types.ts";
import type { AgentServiceTier } from "./service-tier.ts";
import type { WorkspaceAgentConversationInfo } from "./session-store.ts";
import type { TreeFilterMode } from "./session-tree.ts";
import {
  findTranscriptItem,
  isBashTool,
  toolDetailsIndicateError,
  type SessionImageRef,
  type ToolView,
  type ToolViewDetails,
  type TranscriptItem,
  type WorkingTranscriptItem,
} from "./transcript.ts";
import { finishNotificationTurn, startNotificationTurn } from "./turn-notifications.ts";
import { sendTurnNotification } from "./web-push.ts";
import { publishWorkspaceAgentBusy } from "./workspace-agent-busy.ts";

interface LiveState {
  items: TranscriptItem[];
  innerNotices: TranscriptItem[];
  working: Omit<WorkingTranscriptItem, "items">;
  finalStarted?: boolean;
  messageTextIndices: Map<number, number>;
  userEntryId: string;
  open?: { index: number; kind: "text"; contentIndex: number } | { index: number; kind: "thinking" | "toolargs" };
  toolIndexByCallId: Map<string, number>;
  terminalTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface LiveToolCall {
  callId: string;
  name: string;
  args: JsonObject;
}

const positiveSecondsSchema = Type.Number({ exclusiveMinimum: 0 });

function bashTimeoutSeconds(args: JsonObject): number {
  return Value.Check(positiveSecondsSchema, args.timeout) ? args.timeout : 600;
}

/** Only attach the inline terminal when a tool call has been running this long. */
const terminalRevealMs = 3000;
const liveContentFlushIntervalMs = 50;
// Roughly the largest 5% of historical invocation arguments. Keep small calls responsive.
const largeToolArgsBytes = 2 * 1024;
const largeToolArgsFlushIntervalMs = 500;
export abstract class BaseAgentRuntime implements WorkspaceAgentRuntime {
  workspaceId: string;
  conversationId: string;
  title: string;
  label: string;
  sessionFile: string;
  protected ctx: AgentRenderContext;
  protected live?: LiveState;
  private announcedBusy = false;
  private disposed = false;
  private readonly pendingUsers = new Map<string, Extract<TranscriptItem, { type: "user" }>>();
  private readonly turnPresentations = new Map<string, {
    presentation: ReturnType<typeof createLivePresentation>;
    subscriptions: Set<AgentLivePresentationSubscription>;
  }>();
  private toolArgsFlushTimer?: ReturnType<typeof setTimeout>;
  protected liveSubscriberCount = 0;

  private completionCatalogHtml = "";
  private readonly completionCatalogRefresh = createPublishedRefresh(
    () => renderWorkspaceCompletionCatalog(this.workspaceId),
    html => { this.completionCatalogHtml = html; this.livePresentation.invalidate(); },
  );
  private footer: AgentStatsView = { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, thinkingLevel: "", thinkingLevels: [], models: [] };
  private readonly transcriptRendering = new LiveTranscriptRenderer();
  private readonly noticeListeners = new Set<AgentLivePresentationListener>();
  private readonly textRendering = new Map<string, { source: string; renderer: StreamingMarkdownRenderer; stableHtml: string; tailHtml: string }>();
  private readonly footerRefresh = createPublishedRefresh(() => this.statsView(), footer => {
    this.footer = footer;
    this.livePresentation.invalidate();
  });
  private readonly livePresentation = createLivePresentation(() => [
    this.transcriptRendering.renderTranscript(this.renderContext(), this.itemsForDisplay(), this.modelContext()),
    { target: notificationControlId(this.ctx), html: renderNotificationControl(this.ctx, this.isStreaming), action: "replace" },
    { target: ids.actions(this.ctx), html: renderPromptActions(this.ctx, this.isStreaming) },
    { target: ids.completionCatalog(this.ctx), html: this.completionCatalogHtml },
    { target: ids.stats(this.ctx), html: renderAgentPaneComposerFooter(this.ctx, this.footer), morph: false },
  ], liveContentFlushIntervalMs);

  private renderContext(): AgentRenderContext {
    return { ...this.ctx, streamingText: (key, source) => {
      let cached = this.textRendering.get(key);
      if (!cached || !source.startsWith(cached.source)) {
        cached = { source: "", renderer: new StreamingMarkdownRenderer(this.workspaceId), stableHtml: "", tailHtml: "" };
        this.textRendering.set(key, cached);
      }
      if (source !== cached.source) {
        const update = cached.renderer.render(source);
        cached.stableHtml += update.stableHtmlAddition;
        cached.tailHtml = update.tailHtml;
        cached.source = source;
      }
      return cached;
    } };
  }

  protected invalidatePresentation(): void {
    if (this.disposed) return;
    this.livePresentation.invalidate();
    for (const channel of this.turnPresentations.values()) channel.presentation.invalidate();
  }

  constructor(agent: WorkspaceAgentConversationInfo, protected readonly options: WorkspaceAgentRuntimeOptions = {}) {
    this.workspaceId = agent.workspaceId;
    this.conversationId = agent.conversationId;
    this.title = agent.title;
    this.label = agent.label;
    this.sessionFile = agent.path;
    this.ctx = { workspaceId: agent.workspaceId, conversationId: agent.conversationId };
  }

  protected async emitTurnFinished(): Promise<void> {
    if (this.disposed) return;
    const subscription = finishNotificationTurn(this.ctx);
    if (subscription) void sendTurnNotification(this.ctx, subscription).catch((error) => {
      console.error("Could not send Agent turn notification", error);
      this.notice("error", "The turn ended, but its push notification could not be sent.");
    });
    await this.options.events?.emit("workspace_agent_turn_finished", { workspaceId: this.workspaceId, conversationId: this.conversationId });
  }

  get isStreaming(): boolean {
    return this.announcedBusy;
  }

  subscribeLivePresentation(listener: AgentLivePresentationListener): AgentLivePresentationSubscription {
    this.assertActive();
    const subscription = this.livePresentation.subscribe(listener);
    this.noticeListeners.add(listener);
    this.liveSubscriberCount += 1;
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      subscription.unsubscribe();
      this.noticeListeners.delete(listener);
      this.liveSubscriberCount -= 1;
      if (this.liveSubscriberCount === 0 && this.turnSubscriberCount === 0) {
        this.cancelToolArgsFlush();
      }
    };
    return { unsubscribe };
  }

  /** A turn channel exists only while a browser has explicitly opened its disclosure. */
  subscribeTurnPresentation(turnId: string, branchId: string, listener: AgentLivePresentationListener): AgentLivePresentationSubscription {
    this.assertActive();
    if (branchId !== this.ctx.branchId) throw new Error("Turn subscription belongs to an obsolete branch");
    const item = findTranscriptItem(this.itemsForDisplay(), turnId);
    if (item?.type !== "working") throw new Error(`Unknown turn: ${turnId}`);
    let channel = this.turnPresentations.get(turnId);
    if (!channel) {
      channel = {
        subscriptions: new Set(),
        presentation: createLivePresentation(() => {
          const turn = findTranscriptItem(this.itemsForDisplay(), turnId);
          if (turn?.type !== "working") return [];
          return [this.transcriptRendering.renderTurn(this.renderContext(), turn)];
        }, liveContentFlushIntervalMs),
      };
      this.turnPresentations.set(turnId, channel);
    }
    const ownedChannel = channel;
    const subscription = channel.presentation.subscribe(listener);
    let active = true;
    const owned: AgentLivePresentationSubscription = {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        subscription.unsubscribe();
        ownedChannel.subscriptions.delete(owned);
        if (ownedChannel.subscriptions.size === 0 && this.turnPresentations.get(turnId) === ownedChannel) this.turnPresentations.delete(turnId);
        if (this.liveSubscriberCount === 0 && this.turnSubscriberCount === 0) {
          this.cancelToolArgsFlush();
        }
      },
    };
    ownedChannel.subscriptions.add(owned);
    return owned;
  }

  protected resetTurnSubscriptions(branchId: string): void {
    for (const channel of this.turnPresentations.values()) {
      for (const subscription of [...channel.subscriptions]) subscription.unsubscribe();
    }
    this.ctx.branchId = branchId;
    this.textRendering.clear();
    this.transcriptRendering.clear();
  }

  protected get turnSubscriberCount(): number {
    return this.live ? this.turnPresentations.get(this.live.working.key)?.subscriptions.size ?? 0 : 0;
  }

  private itemIsOutside(item: TranscriptItem): boolean {
    return (item.type === "user" && !item.steering) || item.type === "error" || item.type === "note" || (item.type === "text" && item.final);
  }

  protected livePendingUser(key: string, text: string, images: SessionImageRef[] = []): void {
    const item: Extract<TranscriptItem, { type: "user" }> = { type: "user", key, text, images, timestamp: Date.now(), pending: true };
    this.pendingUsers.set(key, item);
    this.invalidatePresentation();
  }

  protected liveConsumePendingUser(key: string): void {
    this.pendingUsers.delete(key);
    this.invalidatePresentation();
  }

  protected assertActive(): void {
    if (this.disposed) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${this.conversationId}`);
  }

  protected markDisposed(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    this.livePresentation.dispose();
    this.noticeListeners.clear();
    this.footerRefresh.dispose();
    this.completionCatalogRefresh.dispose();
    this.resetTurnSubscriptions(this.ctx.branchId ?? "");
    finishNotificationTurn(this.ctx);
    this.cancelToolArgsFlush();
    return true;
  }

  protected setBusy(busy: boolean): void {
    if (this.announcedBusy === busy) return;
    this.announcedBusy = busy;
    if (busy) startNotificationTurn(this.ctx, () => {
      this.invalidatePresentation();
    });
    this.invalidatePresentation();
    publishWorkspaceAgentBusy({ workspaceId: this.workspaceId, agentKey: `agent:${this.conversationId}`, busy });
  }

  protected notice(level: "info" | "error", message: string): void {
    const html = turboStream("append", ids.notices(this.ctx), renderNotice(level, message));
    for (const listener of this.noticeListeners) listener(html);
  }

  // ---- live transcript streaming ----------------------------------------

  private liveKey(live: LiveState, index: number, kind: string): string {
    return `${live.userEntryId}:${index}:${kind}`;
  }

  protected liveBegin(user: { text: string; images: SessionImageRef[] } | undefined, entryId: string, now = Date.now()): void {
    if (this.live) return;
    const live: LiveState = {
      items: [],
      innerNotices: [],
      messageTextIndices: new Map(),
      userEntryId: entryId,
      working: { type: "working", timestamp: now, key: `${entryId}:working`, inputEntryIds: [entryId], startedAt: now, live: true },
      toolIndexByCallId: new Map(),
      terminalTimers: new Map(),
    };
    this.live = live;
    if (user) {
      const item: TranscriptItem = { type: "user", timestamp: now, key: entryId, rewindEntryId: entryId, text: user.text, images: user.images };
      live.items.push(item);
    }
    this.invalidatePresentation();
  }

  protected liveSteeringUser(entryId: string, user: { text: string; images: SessionImageRef[] }, pendingKey?: string): void {
    const live = this.liveEnsure();
    const item: TranscriptItem = { type: "user", key: entryId, rewindEntryId: entryId, timestamp: Date.now(), ...user, steering: true };
    live.working.inputEntryIds!.push(entryId);
    live.items.push(item);
    if (pendingKey) this.liveConsumePendingUser(pendingKey);
    this.publishLiveItem(item);
  }

  protected liveEnsure(): LiveState {
    if (!this.live) throw new Error("Assistant activity has no consumed turn entry");
    return this.live;
  }

  protected liveTiming(): WorkingTranscriptItem["timing"] { return this.live?.working.timing; }

  private liveWorkingSection(live: LiveState): WorkingTranscriptItem {
    return { ...live.working, timing: this.liveTiming(), items: [...live.innerNotices, ...live.items.filter((item) => !this.itemIsOutside(item))] };
  }

  protected liveItemsForDisplay(live: LiveState): TranscriptItem[] {
    const user = live.items.filter((item) => item.key === live.userEntryId);
    const trailing = live.items.filter((item) => item.key !== live.userEntryId && this.itemIsOutside(item));
    return [...user, this.liveWorkingSection(live), ...trailing];
  }

  private publishLiveItem(item: TranscriptItem): void {
    item.timestamp ??= Date.now();
    this.invalidatePresentation();
  }

  private openTextItem(): Extract<TranscriptItem, { type: "text" }> | undefined {
    const live = this.live;
    if (!live?.open || live.open.kind !== "text") return undefined;
    const item = live.items[live.open.index];
    return item?.type === "text" ? item : undefined;
  }

  private finishOpenText(final = false): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "text") return;
    const item = live.items[live.open.index];

    if (item?.type === "text") {
      item.live = false;
      item.final = final;
      this.invalidatePresentation();
    }
    live.open = undefined;
  }

  private finishOpenThinking(): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "thinking") return;
    const item = live.items[live.open.index];
    if (item?.type === "thinking") {
      item.live = false;
      this.invalidatePresentation();
    }
    live.open = undefined;
  }

  protected closeOpenItem(): void {
    this.finishOpenText(Boolean(this.openTextItem()?.final));
    this.finishOpenThinking();
    if (this.live) this.live.open = undefined;
  }

  protected liveAssistantMessageStart(): void {
    this.closeOpenItem();
    const live = this.liveEnsure();
    live.messageTextIndices.clear();
    live.finalStarted = false;
  }

  protected liveFinalStart(): void {
    const live = this.liveEnsure();
    live.finalStarted = true;
    if (live.open?.kind === "thinking") this.finishOpenThinking();
    if (live.open?.kind === "text") {
      const item = live.items[live.open.index];
      if (item?.type === "text" && !item.final) {
        item.final = true;
        this.invalidatePresentation();
      }
    }
  }

  protected liveTextStart(contentIndex: number, final: boolean): void {
    const live = this.liveEnsure();
    if (live.open?.kind === "thinking") this.finishOpenThinking();
    if (live.open?.kind === "text" && live.open.contentIndex !== contentIndex) this.finishOpenText(Boolean(this.openTextItem()?.final));
    if (final) this.liveFinalStart();
  }

  protected liveTextDelta(text: string, contentIndex: number, final: boolean): void {
    this.liveTextStart(contentIndex, final);
    const live = this.liveEnsure();
    if (!live.open || live.open.kind !== "text") {
      const index = live.items.length;
      const finalItem = Boolean(live.finalStarted);
      const item: TranscriptItem = { type: "text", key: this.liveKey(live, index, "text"), text: "", final: finalItem, live: true };
      live.items.push(item);
      live.open = { index, kind: "text", contentIndex };
      live.messageTextIndices.set(contentIndex, index);
      this.publishLiveItem(item);
    }
    const item = live.items[live.open.index];
    if (item?.type !== "text") return;
    item.text += text;
    // Publication is coalesced; snapshots always read the latest source.
    this.invalidatePresentation();
  }

  protected liveTextEnd(contentIndex: number): void {
    const live = this.live;
    if (!live || live.open?.kind !== "text" || live.open.contentIndex !== contentIndex) return;
    const item = live.items[live.open.index];
    this.finishOpenText(item?.type === "text" && item.final);
  }

  protected liveThinkingDelta(text: string): void {
    const live = this.liveEnsure();
    if (live.open?.kind === "text") this.finishOpenText(false);
    if (!live.open || live.open.kind !== "thinking") {
      const index = live.items.length;
      const item: TranscriptItem = { type: "thinking", key: this.liveKey(live, index, "thinking"), text: "", live: true };
      live.items.push(item);
      live.open = { index, kind: "thinking" };
      this.publishLiveItem(item);
    }
    const item = live.items[live.open.index];
    if (item?.type !== "thinking") return;
    item.text += text;
    this.invalidatePresentation();
  }

  protected liveToolStreamStart(name: string): number {
    this.cancelToolArgsFlush();
    const live = this.liveEnsure();
    if (live.open?.kind === "text") this.finishOpenText(false);
    if (live.open?.kind === "thinking") this.finishOpenThinking();
    live.open = undefined;
    const index = live.items.length;
    const key = this.liveKey(live, index, "tool");
    const tool: ToolView = { callId: key, name, args: undefined, status: "streaming", argsStream: "" };
    const item: TranscriptItem = { type: "tool", key, tool };
    live.items.push(item);
    live.open = { index, kind: "toolargs" };
    this.publishLiveItem(item);
    return index;
  }

  protected liveToolArgsDelta(text: string): void {
    const live = this.live;
    if (!live || live.open?.kind !== "toolargs") return;
    const item = live.items[live.open.index];
    if (item?.type !== "tool") return;
    item.tool.argsStream = (item.tool.argsStream ?? "") + text;
    // The authoritative prefix changes immediately. Expensive argument rendering is paced.
    if (this.turnSubscriberCount === 0 || this.toolArgsFlushTimer) return;
    // An already scheduled flush may finish at the fast cadence; subsequent flushes
    // use the accumulated UTF-8 argument size, without postponing work on every delta.
    const intervalMs = Buffer.byteLength(item.tool.argsStream, "utf8") >= largeToolArgsBytes
      ? largeToolArgsFlushIntervalMs
      : liveContentFlushIntervalMs;
    this.toolArgsFlushTimer = setTimeout(() => {
      this.toolArgsFlushTimer = undefined;
      for (const channel of this.turnPresentations.values()) channel.presentation.flush();
    }, intervalMs);
  }

  private cancelToolArgsFlush(): void {
    if (this.toolArgsFlushTimer) clearTimeout(this.toolArgsFlushTimer);
    this.toolArgsFlushTimer = undefined;
  }

  protected liveToolCallComplete(call: LiveToolCall): void {
    this.cancelToolArgsFlush();
    const { callId, name, args } = call;
    const live = this.liveEnsure();
    const streamedIndex = live.open?.kind === "toolargs" ? live.open.index : undefined;
    let index: number;
    if (streamedIndex !== undefined) index = streamedIndex;
    else {
      index = live.items.length;
      const key = `tool:${callId}`;
      live.items.push({ type: "tool", key, tool: { callId, name, args, status: "running" } });
    }
    live.open = undefined;
    const item = live.items[index];
    if (item?.type !== "tool") return;
    item.key = `tool:${callId}`;
    item.tool.callId = callId;
    item.tool.name = name;
    item.tool.args = args;
    item.tool.status = "running";
    item.tool.argsStream = undefined;
    item.tool.startedAt = Date.now();
    if (isBashTool(name)) item.tool.timeoutSeconds = bashTimeoutSeconds(args);
    live.toolIndexByCallId.set(callId, index);
    if (streamedIndex !== undefined) {
      // Replace the provisional argument row as soon as Pi supplies its call ID.
      // Every later detail URL then uses the same identity as persisted history.
      this.invalidatePresentation();
    } else {
      this.publishLiveItem(item);
    }
  }

  protected liveToolExecStart(call: LiveToolCall): void {
    const live = this.liveEnsure();
    if (!live.toolIndexByCallId.has(call.callId)) this.liveToolCallComplete(call);
  }

  protected liveToolUpdate(callId: string, update: { tmuxSession?: string; outputText?: string; details?: ToolViewDetails }): void {
    const live = this.live;
    const index = live?.toolIndexByCallId.get(callId);
    if (!live || index === undefined) return;
    const item = live.items[index];
    if (item?.type !== "tool") return;
    if (update.tmuxSession && !item.tool.tmuxSession) {
      item.tool.tmuxSession = update.tmuxSession;
      const timer = setTimeout(() => {
        const current = this.live;
        const revisit = current?.items[index];
        if (!current || revisit?.type !== "tool" || revisit.tool.status !== "running") return;
        revisit.tool.terminalVisible = true;
        this.invalidatePresentation();
      }, terminalRevealMs);
      live.terminalTimers.set(callId, timer);
    }
    if (update.outputText !== undefined) item.tool.resultText = update.outputText;
    if (update.details !== undefined) item.tool.details = update.details;
    this.invalidatePresentation();
  }

  protected liveToolEnd(callId: string, resultText: string, isError: boolean, details?: ToolViewDetails): void {
    const live = this.live;
    const index = live?.toolIndexByCallId.get(callId);
    if (!live || index === undefined) return;
    const timer = live.terminalTimers.get(callId);
    if (timer) clearTimeout(timer);
    live.terminalTimers.delete(callId);
    const item = live.items[index];
    if (item?.type !== "tool") return;
    const completedAt = Date.now();
    item.tool.durationMs = item.tool.startedAt ? completedAt - item.tool.startedAt : undefined;
    item.tool.status = isError || toolDetailsIndicateError(details) ? "error" : "ok";
    item.tool.resultText = resultText;
    item.tool.details = details;
    item.tool.tmuxSession = undefined;
    item.tool.terminalVisible = undefined;
    this.invalidatePresentation();
  }

  protected liveNote(text: string, tone: "system" | "summary" | "error"): void {
    const live = this.liveEnsure();
    this.closeOpenItem();
    const item: TranscriptItem = tone === "error"
      ? { type: "error", key: this.liveKey(live, live.items.length, "error"), text }
      : { type: "note", key: this.liveKey(live, live.items.length, "note"), text, tone };
    live.items.push(item);
    this.publishLiveItem(item);
  }

  protected liveAssistantFailure(): void {
    const live = this.live;
    if (!live) return;
    this.closeOpenItem();
    for (const index of live.messageTextIndices.values()) {
      const item = live.items[index];
      if (item?.type !== "text" || !item.final) continue;
      item.final = false;
      this.publishLiveItem(item);
    }
    live.finalStarted = false;
  }

  protected liveInnerError(text: string): void {
    const live = this.liveEnsure();
    this.closeOpenItem();
    const item: TranscriptItem = { type: "error", key: this.liveKey(live, live.innerNotices.length, "retry"), text };
    live.innerNotices.push(item);
    this.invalidatePresentation();
  }

  protected liveFinal(text: string, contentIndexes?: number[]): void {
    const live = this.live;
    if (!live) return;

    live.open = undefined;
    const selected = new Set(contentIndexes ?? live.messageTextIndices.keys());
    const removeIndices = new Set([...live.messageTextIndices].filter(([contentIndex]) => selected.has(contentIndex)).map(([, index]) => index));

    live.items = live.items.filter((_, index) => !removeIndices.has(index));
    // All tools in this assistant message have completed before a final answer.
    live.toolIndexByCallId.clear();
    live.messageTextIndices.clear();
    const index = live.items.length;
    const item: TranscriptItem = { type: "text", key: this.liveKey(live, index, "final"), text, final: true };
    live.finalStarted = true;
    live.items.push(item);
    this.publishLiveItem(item);
  }

  protected liveCacheMiss(miss: CacheMiss): void {
    const text = significantCacheMissNotice(miss);
    if (!text) return;
    const live = this.liveEnsure();
    const item: TranscriptItem = { type: "note", key: this.liveKey(live, live.items.length, "cache-miss"), text, tone: "warning" };
    live.items.push(item);
    this.publishLiveItem(item);
  }

  /** End the live model synchronously; terminal lifecycle must not wait on stats I/O. */
  protected finishLivePresentation(outcome: "completed" | "stopped" = "stopped"): void {
    this.cancelToolArgsFlush();
    this.finishOpenText(Boolean(this.openTextItem()?.final));

    if (this.live) {
      for (const timer of this.live.terminalTimers.values()) clearTimeout(timer);
      if (outcome === "completed") this.live.working.completedAt = Date.now();
      else this.live.working.stoppedAt = Date.now();
    }
    this.live = undefined;
    this.textRendering.clear();
    this.transcriptRendering.clear();
    this.invalidatePresentation();
  }

  protected decorateTranscript(items: TranscriptItem[]): TranscriptItem[] { return items; }

  private itemsForDisplay(): TranscriptItem[] {
    let items = this.canonicalItems();
    const live = this.live;
    if (!live) return [...this.decorateTranscript(items), ...this.pendingUsers.values()];
    const index = items.findIndex((item) => item.key === live.userEntryId || item.key === live.working.key);
    if (index >= 0) items = items.slice(0, index);
    return [...this.decorateTranscript([...items, ...this.liveItemsForDisplay(live)]), ...this.pendingUsers.values()];
  }

  protected async refreshStats(): Promise<void> { await this.footerRefresh.refresh(); }

  revealTurn(target: string): string | undefined {
    const items = this.itemsForDisplay();
    return items.find(item => item.type === "working" && item.items.some(child => child.key === target || child.anchor === target))?.key;
  }

  async refreshCompletionCatalog(): Promise<string> {
    this.assertActive();
    await this.completionCatalogRefresh.refresh();
    return this.completionCatalogHtml;
  }

  async paneState(): Promise<AgentPaneState> {
    this.assertActive();
    void this.refreshStats().catch(error => console.error("Could not refresh agent footer", error));
    return { transcriptHtml: this.transcriptRendering.renderInitialTranscript(this.renderContext(), this.itemsForDisplay(), this.modelContext()), busy: this.isStreaming, stats: this.footer };
  }

  async detailHtml(key: string, count = 100): Promise<string> {
    this.assertActive();
    if (key === "system-prompt" || key === "tool-definitions") return renderModelContextDetailFrame(this.ctx, this.modelContext(), key);
    const item = findTranscriptItem(this.itemsForDisplay(), key);
    return item ? renderTranscriptItemDetailFrame(this.ctx, item, { count }) : "";
  }

  protected abstract modelContext(): AgentModelContextView;
  abstract userMessages(): string[];
  protected abstract canonicalItems(leafId?: string): TranscriptItem[];
  protected abstract statsView(): Promise<AgentStatsView>;
  abstract submit(text: string, options?: SubmitOptions): Promise<void>;
  abstract compact(customInstructions?: string): Promise<void>;
  abstract abort(): Promise<void>;
  abstract dispose(): Promise<void>;
  abstract currentModel(): { provider: string; id: string } | undefined;
  abstract currentThinkingLevel(): string;
  abstract availableThinkingLevels(): string[];
  async refreshModelConfiguration(): Promise<void> { await this.refreshStats(); }
  abstract setModel(provider: string, modelId: string): Promise<void>;
  abstract setThinkingLevel(level: string): Promise<void>;
  abstract setServiceTier(serviceTier: AgentServiceTier): Promise<void>;
  abstract rewind(entryId: string, mode: RewindMode, customInstructions?: string): Promise<void>;
  abstract treeHtml(options: { filter: TreeFilterMode; query: string }): string;
  abstract labelTreeEntry(entryId: string, label: string, operation: "add" | "remove"): void;
  abstract navigateTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string>;
  abstract newSession(): Promise<void>;
}
