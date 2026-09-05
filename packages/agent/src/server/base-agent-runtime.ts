import { AtelierCoreError, type JsonObject } from "@atelier/core";
import { StreamingMarkdownRenderer } from "@atelier/markdown";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { significantCacheMissNotice, type CacheMiss } from "./cache-miss.ts";
import { escapeHtml, turboStream } from "./html.ts";
import { createSnapshotFirstLivePresentation } from "./live-presentation.ts";
import { renderNotice } from "./render-attachments.ts";
import { renderAgentPaneComposerFooter, renderPromptActions, type AgentPaneState, type AgentStatsView } from "./render-composer.ts";
import { ids, type AgentRenderContext } from "./render-context.ts";
import { renderActiveToolContent, toolPresentation } from "./render-tool.ts";
import {
  renderModelContextDetailFrame,
  renderTranscript,
  renderTranscriptItem,
  renderTranscriptItemDetailFrame,
  type AgentModelContextView,
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
  toolDetailsIndicateError,
  type SessionImageRef,
  type TranscriptItem,
  type WorkingTranscriptItem,
  type ToolViewDetails,
  type ToolView,
} from "./transcript.ts";
import type { TurnTimingSummary } from "./turn-timing.ts";
import { publishWorkspaceViewBusy } from "./workspace-view-busy.ts";

interface LiveTextStream {
  displayedLength: number;
  renderer: StreamingMarkdownRenderer;
  timer?: ReturnType<typeof setTimeout>;
}

interface LiveState {
  id: string;
  items: TranscriptItem[];
  cacheMissNotices: TranscriptItem[];
  working: Omit<WorkingTranscriptItem, "items">;
  lastActivityAt: number;
  finalIndex?: number;
  userEntryId?: string;
  open?: { index: number; kind: "text"; contentIndex: number } | { index: number; kind: "thinking" | "toolargs" };
  textStream?: LiveTextStream;
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
  private toolArgsFlushTimer?: ReturnType<typeof setTimeout>;
  protected liveSubscriberCount = 0;
  private readonly livePresentation = createSnapshotFirstLivePresentation((publishToExisting) => {
    this.alignTextStreamForSnapshot(publishToExisting);
    return this.captureAuthoritativePresentationUpdate();
  });

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
    await this.options.events?.emit("workspace_agent_turn_finished", { workspaceId: this.workspaceId, conversationId: this.conversationId });
    // Re-announce terminal actions after unread state is recorded. A connected,
    // logically visible pane uses this targeted update to acknowledge that exact
    // conversation without affecting sibling Agents.
    this.stream(turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, this.isStreaming)));
  }

  get isStreaming(): boolean {
    return this.announcedBusy;
  }

  subscribeLivePresentation(listener: AgentLivePresentationListener): AgentLivePresentationSubscription {
    this.assertActive();
    this.liveSubscriberCount += 1;
    const subscription = this.livePresentation.subscribe(listener);
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      subscription.unsubscribe();
      this.liveSubscriberCount -= 1;
      if (this.liveSubscriberCount === 0) {
        this.cancelTextFlush();
        this.cancelToolArgsFlush();
      }
    };
    const ready = subscription.ready.catch((error) => {
      unsubscribe();
      throw error;
    });
    return { ready, unsubscribe };
  }

  protected stream(html: string): void {
    if (this.disposed) return;
    this.livePresentation.publish(html);
  }

  private streamText(html?: string): void {
    if (this.disposed) return;
    this.livePresentation.publish(html, { kind: "paced-text" });
  }

  protected async streamRendered(render: () => Promise<string>): Promise<void> {
    if (this.disposed) return;
    await this.livePresentation.publishRendered(render);
  }

  protected assertActive(): void {
    if (this.disposed) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${this.conversationId}`);
  }

  protected markDisposed(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    this.cancelToolArgsFlush();
    return true;
  }

  protected setBusy(busy: boolean): void {
    if (this.announcedBusy === busy) return;
    this.announcedBusy = busy;
    publishWorkspaceViewBusy({ workspaceId: this.workspaceId, viewKey: `agent:${this.conversationId}`, busy });
    this.stream(turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, busy)));
  }

  protected notice(level: "info" | "error", message: string): void {
    this.livePresentation.publish(turboStream("append", ids.notices(this.ctx), renderNotice(level, message)), { kind: "ephemeral" });
  }

  // ---- live transcript streaming ----------------------------------------

  private liveKey(live: LiveState, index: number, kind: string): string {
    return `${live.id}:${index}:${kind}`;
  }

  protected liveBegin(user?: { text: string; images: SessionImageRef[] }): void {
    if (this.live) return;
    const now = Date.now();
    const id = `live_${now.toString(36)}`;
    const live: LiveState = {
      id,
      items: [],
      cacheMissNotices: [],
      working: { type: "working", key: `${id}:working`, startedAt: now, live: true },
      lastActivityAt: now,
      toolIndexByCallId: new Map(),
      terminalTimers: new Map(),
    };
    this.live = live;
    if (user) {
      const item: TranscriptItem = { type: "user", key: `${live.id}:user`, text: user.text, images: user.images };
      live.items.push(item);
      this.stream(turboStream("append", ids.transcript(this.ctx), renderTranscriptItem(this.ctx, item, { live: true })));
    }
    this.stream(turboStream("append", ids.transcript(this.ctx), renderTranscriptItem(this.ctx, this.liveWorkingSection(live))));
  }

  protected liveEnsure(): LiveState {
    if (!this.live) this.liveBegin();
    return this.live!;
  }

  private liveWorkingSection(live: LiveState): WorkingTranscriptItem {
    const userIndex = live.items[0]?.type === "user" ? 1 : 0;
    const end = live.finalIndex ?? live.items.length;
    return { ...live.working, items: [...live.cacheMissNotices, ...live.items.slice(userIndex, end)] };
  }

  protected liveItemsForDisplay(live: LiveState): TranscriptItem[] {
    const user = live.items[0]?.type === "user" ? [live.items[0]] : [];
    const trailing = live.finalIndex === undefined ? [] : live.items.slice(live.finalIndex);
    return [...user, this.liveWorkingSection(live), ...trailing];
  }

  private appendLiveItem(item: TranscriptItem, options: { live?: boolean; open?: boolean } = {}): void {
    const live = this.live!;
    const target = live.finalIndex === undefined ? ids.workingItems(this.ctx, live.working.key) : ids.transcript(this.ctx);
    this.stream(turboStream("append", target, renderTranscriptItem(this.ctx, item, options)));
  }

  private openTextItem(): Extract<TranscriptItem, { type: "text" }> | undefined {
    const live = this.live;
    if (!live?.open || live.open.kind !== "text") return undefined;
    const item = live.items[live.open.index];
    return item?.type === "text" ? item : undefined;
  }

  private cancelTextFlush(): void {
    const streamState = this.live?.textStream;
    if (streamState?.timer) clearTimeout(streamState.timer);
    if (streamState) streamState.timer = undefined;
  }

  /** Bring existing listeners to the exact full-text boundary captured for a joining subscriber. */
  private alignTextStreamForSnapshot(publishToExisting: (html: string) => void): void {
    const item = this.openTextItem();
    const streamState = this.live?.textStream;
    if (!item || !streamState) return;
    this.cancelTextFlush();
    // Always replace for existing listeners. A paced update can already have
    // advanced the shared renderer while its ordered delivery is still queued
    // behind this snapshot, so displayedLength alone cannot prove that every
    // listener has observed it.
    publishToExisting(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { live: true })));
    streamState.renderer.sync(item.text);
    streamState.displayedLength = item.text.length;
  }

  private scheduleTextFlush(): void {
    const streamState = this.live?.textStream;
    if (!streamState || streamState.timer || this.liveSubscriberCount === 0) return;
    streamState.timer = setTimeout(() => {
      streamState.timer = undefined;
      this.flushText();
    }, liveContentFlushIntervalMs);
  }

  private flushText(): void {
    const item = this.openTextItem();
    const streamState = this.live?.textStream;
    if (!item || !streamState) return;
    if (item.text.length === streamState.displayedLength) return;
    const update = streamState.renderer.render(item.text);
    streamState.displayedLength = item.text.length;
    const stable = update.stableHtmlAddition
      ? turboStream("append", ids.itemTextStable(this.ctx, item.key), update.stableHtmlAddition)
      : "";
    this.streamText(stable + turboStream("update", ids.itemTextTail(this.ctx, item.key), update.tailHtml));
  }

  private releaseTextStream(): void {
    this.cancelTextFlush();
    if (this.live) this.live.textStream = undefined;
  }

  protected streamActiveToolContent(item: Extract<TranscriptItem, { type: "tool" }>): void {
    if (this.liveSubscriberCount === 0) {
      this.livePresentation.publish();
      return;
    }
    const content = renderActiveToolContent(this.ctx, item.key, item.tool);
    const summary = turboStream("update", ids.itemSummaryContent(this.ctx, item.key), content.summary);
    const detail = content.detail === undefined ? "" : turboStream("update", ids.detailFrame(this.ctx, item.key), content.detail);
    this.stream(summary + detail);
  }

  private finishOpenText(final = false): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "text") return;
    const item = live.items[live.open.index];
    this.releaseTextStream();
    if (item?.type === "text") {
      item.live = false;
      item.final = final;
      if (!final) live.lastActivityAt = Date.now();
      if (this.liveSubscriberCount > 0) this.stream(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item)));
    }
    live.open = undefined;
  }

  private finishOpenThinking(): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "thinking") return;
    const item = live.items[live.open.index];
    if (item?.type === "thinking") {
      item.live = false;
      live.lastActivityAt = Date.now();
      this.stream(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { open: true })));
    }
    live.open = undefined;
  }

  protected closeOpenItem(): void {
    this.finishOpenText(false);
    this.finishOpenThinking();
    if (this.live) this.live.open = undefined;
  }

  protected liveFinalStart(): void {
    const live = this.liveEnsure();
    if (live.working.completedAt !== undefined) return;
    if (live.open?.kind === "thinking") this.finishOpenThinking();
    if (live.open?.kind === "text") {
      const index = live.open.index;
      const item = live.items[index];
      this.releaseTextStream();
      if (item?.type === "text") {
        item.live = false;
        item.final = true;
        live.finalIndex = index;
      }
      live.open = undefined;
    }
    live.working.completedAt = live.lastActivityAt;
    const working = turboStream("replace", ids.item(this.ctx, live.working.key), renderTranscriptItem(this.ctx, this.liveWorkingSection(live)));
    const final = live.finalIndex === undefined ? "" : turboStream("append", ids.transcript(this.ctx), renderTranscriptItem(this.ctx, live.items[live.finalIndex]!));
    this.stream(working + final);
  }

  protected liveTextStart(contentIndex: number, final: boolean): void {
    const live = this.liveEnsure();
    if (live.open?.kind === "thinking") this.finishOpenThinking();
    if (live.open?.kind === "text" && live.open.contentIndex !== contentIndex) this.finishOpenText(false);
    if (final) this.liveFinalStart();
  }

  protected liveTextDelta(text: string, contentIndex: number, final: boolean): void {
    this.liveTextStart(contentIndex, final);
    const live = this.liveEnsure();
    if (!live.open || live.open.kind !== "text") {
      const index = live.items.length;
      const finalItem = live.working.completedAt !== undefined;
      const item: TranscriptItem = { type: "text", key: this.liveKey(live, index, "text"), text: "", final: finalItem, live: true };
      if (finalItem) live.finalIndex = index;
      live.items.push(item);
      live.open = { index, kind: "text", contentIndex };
      live.textStream = { displayedLength: 0, renderer: new StreamingMarkdownRenderer(this.workspaceId) };
      this.appendLiveItem(item, { live: true });
    }
    const item = live.items[live.open.index];
    if (item?.type !== "text") return;
    item.text += text;
    // Authoritative text changes immediately even though its visible update is paced.
    // Invalidate any in-flight snapshot so it cannot straddle this change.
    this.streamText();
    this.scheduleTextFlush();
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
      this.appendLiveItem(item, { live: true, open: true });
    }
    const item = live.items[live.open.index];
    if (item?.type !== "thinking") return;
    item.text += text;
    this.stream(turboStream("update", ids.itemText(this.ctx, item.key), escapeHtml(item.text)));
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
    this.appendLiveItem(item, { live: true, open: true });
    return index;
  }

  protected liveToolArgsDelta(text: string): void {
    const live = this.live;
    if (!live || live.open?.kind !== "toolargs") return;
    const item = live.items[live.open.index];
    if (item?.type !== "tool") return;
    item.tool.argsStream = (item.tool.argsStream ?? "") + text;
    // The authoritative prefix changes immediately. Only rendering is coalesced.
    this.livePresentation.publish();
    if (this.liveSubscriberCount === 0 || this.toolArgsFlushTimer) return;
    this.toolArgsFlushTimer = setTimeout(() => {
      this.toolArgsFlushTimer = undefined;
      this.streamActiveToolContent(item);
    }, liveContentFlushIntervalMs);
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
      const key = this.liveKey(live, index, "tool");
      live.items.push({ type: "tool", key, tool: { callId, name, args, status: "running" } });
    }
    live.open = undefined;
    const item = live.items[index];
    if (item?.type !== "tool") return;
    item.tool.callId = callId;
    item.tool.name = name;
    item.tool.args = args;
    item.tool.status = "running";
    item.tool.argsStream = undefined;
    item.tool.startedAt = Date.now();
    if (name === "bash") item.tool.timeoutSeconds = bashTimeoutSeconds(args);
    live.toolIndexByCallId.set(callId, index);
    if (streamedIndex !== undefined) {
      this.streamActiveToolContent(item);
    } else {
      this.appendLiveItem(item, { live: true, open: true });
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
        this.streamActiveToolContent(revisit);
      }, terminalRevealMs);
      live.terminalTimers.set(callId, timer);
    }
    if (update.outputText !== undefined) item.tool.resultText = update.outputText;
    if (update.details !== undefined) item.tool.details = update.details;
    this.livePresentation.publish();
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
    const wasShowingDetail = toolPresentation(item.tool).showsDetail;
    const completedAt = Date.now();
    item.tool.durationMs = item.tool.startedAt ? completedAt - item.tool.startedAt : undefined;
    live.lastActivityAt = completedAt;
    item.tool.status = isError || toolDetailsIndicateError(details) ? "error" : "ok";
    item.tool.resultText = resultText;
    item.tool.details = details;
    item.tool.tmuxSession = undefined;
    item.tool.terminalVisible = undefined;
    const presentation = toolPresentation(item.tool);
    if (wasShowingDetail !== presentation.showsDetail) {
      this.stream(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { live: true, open: presentation.autoOpenOnReveal })));
    } else {
      this.streamActiveToolContent(item);
    }
  }

  protected liveNote(text: string, tone: "system" | "summary" | "error"): void {
    const live = this.liveEnsure();
    this.closeOpenItem();
    const item: TranscriptItem = { type: "note", key: this.liveKey(live, live.items.length, "note"), text, tone };
    live.items.push(item);
    live.lastActivityAt = Date.now();
    this.appendLiveItem(item, { live: true });
  }

  protected liveFinal(text: string): void {
    const live = this.live;
    if (!live) return;
    if (live.working.completedAt === undefined) this.liveFinalStart();
    if (live.open?.kind === "text") {
      const item = live.items[live.open.index];
      if (item?.type === "text") item.text = text;
      this.finishOpenText(true);
      return;
    }
    const existing = live.finalIndex === undefined ? undefined : live.items[live.finalIndex];
    if (existing?.type === "text") {
      existing.text = text;
      existing.final = true;
      existing.live = false;
      this.stream(turboStream("replace", ids.item(this.ctx, existing.key), renderTranscriptItem(this.ctx, existing)));
      return;
    }
    const index = live.items.length;
    const item: TranscriptItem = { type: "text", key: this.liveKey(live, index, "final"), text, final: true };
    live.finalIndex = index;
    live.items.push(item);
    this.appendLiveItem(item, { live: true });
  }

  protected liveTiming(timing: TurnTimingSummary): void {
    if (!this.live) return;
    this.live.working.timing = timing;
    this.stream(turboStream("replace", ids.item(this.ctx, this.live.working.key), renderTranscriptItem(this.ctx, this.liveWorkingSection(this.live))));
  }

  protected liveCacheMiss(miss: CacheMiss): void {
    const text = significantCacheMissNotice(miss);
    if (!text) return;
    const live = this.liveEnsure();
    const item: TranscriptItem = { type: "note", key: `${live.id}:cache-miss:${live.cacheMissNotices.length}`, text, tone: "warning" };
    live.cacheMissNotices.push(item);
    this.stream(turboStream("append", ids.workingItems(this.ctx, live.working.key), renderTranscriptItem(this.ctx, item, { live: true })));
  }

  /** End the live model synchronously; terminal lifecycle must not wait on stats I/O. */
  protected finishLivePresentation(): void {
    this.cancelToolArgsFlush();
    // Supersede any paced tail with one canonical full-source render before the
    // live state (and its renderer session) is discarded.
    this.finishOpenText(false);
    this.releaseTextStream();
    if (this.live) {
      for (const timer of this.live.terminalTimers.values()) clearTimeout(timer);
      if (this.live.working.completedAt === undefined) {
        this.live.working.stoppedAt = Date.now();
      }
      if (this.liveSubscriberCount > 0) this.stream(turboStream("replace", ids.item(this.ctx, this.live.working.key), renderTranscriptItem(this.ctx, this.liveWorkingSection(this.live))));
    }
    this.live = undefined;
  }

  private itemsForDisplay(): TranscriptItem[] {
    let items = this.canonicalItems();
    const live = this.live;
    if (!live) return items;
    if (live.userEntryId) {
      const index = items.findIndex((item) => item.rewindEntryId === live.userEntryId || item.key === live.userEntryId);
      if (index >= 0) items = items.slice(0, index);
    }
    return [...items, ...this.liveItemsForDisplay(live)];
  }

  protected async refreshTranscript(): Promise<void> {
    await this.streamRendered(async () => turboStream("update", ids.transcript(this.ctx), renderTranscript(this.ctx, this.itemsForDisplay(), this.modelContext())));
  }

  protected async refreshStats(): Promise<void> {
    await this.streamRendered(async () => turboStream("update", ids.stats(this.ctx), renderAgentPaneComposerFooter(this.ctx, await this.statsView())));
  }

  private capturePaneState(): () => Promise<AgentPaneState> {
    // The transcript and busy flag are the mutable live boundary. Capture both
    // synchronously before stats performs any configuration or provider I/O.
    const transcriptHtml = renderTranscript(this.ctx, this.itemsForDisplay(), this.modelContext());
    const busy = this.isStreaming;
    const stats = this.statsView();
    return async () => ({ transcriptHtml, busy, stats: await stats });
  }

  private captureAuthoritativePresentationUpdate(): () => Promise<string> {
    const completeState = this.capturePaneState();
    return async () => {
      const state = await completeState();
      return turboStream("update", ids.transcript(this.ctx), state.transcriptHtml)
        + turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, state.busy))
        + turboStream("update", ids.stats(this.ctx), renderAgentPaneComposerFooter(this.ctx, state.stats));
    };
  }

  protected async authoritativePresentationUpdate(): Promise<string> {
    return await this.captureAuthoritativePresentationUpdate()();
  }

  async paneState(): Promise<AgentPaneState> {
    this.assertActive();
    return await this.capturePaneState()();
  }

  async detailHtml(key: string, count = 100): Promise<string> {
    this.assertActive();
    if (key === "model-context") return renderModelContextDetailFrame(this.ctx, this.modelContext());
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
  abstract setModel(provider: string, modelId: string): Promise<void>;
  abstract setThinkingLevel(level: string): Promise<void>;
  abstract setServiceTier(serviceTier: AgentServiceTier): Promise<void>;
  abstract rewind(entryId: string, mode: RewindMode, customInstructions?: string): Promise<void>;
  abstract treeHtml(options: { filter: TreeFilterMode; query: string }): string;
  abstract labelTreeEntry(entryId: string, label: string, operation: "add" | "remove"): void;
  abstract navigateTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string>;
  abstract newSession(): Promise<void>;
}

