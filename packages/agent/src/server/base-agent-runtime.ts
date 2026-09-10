import { finishNotificationTurn, startNotificationTurn } from "./turn-notifications.ts";
import { sendTurnNotification } from "./web-push.ts";
import { notificationControlTurboStream } from "./render-notification.ts";
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
  renderWorkingSummary,
  renderWorkingContent,
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
import { publishWorkspaceViewBusy } from "./workspace-view-busy.ts";

interface LiveTextStream {
  displayedLength: number;
  renderer: StreamingMarkdownRenderer;
  timer?: ReturnType<typeof setTimeout>;
}

interface ContributedRow {
  html: string;
  parent: string;
  next?: string;
  turnId?: string;
}

interface LiveState {
  items: TranscriptItem[];
  innerNotices: TranscriptItem[];
  working: Omit<WorkingTranscriptItem, "items">;
  finalStarted?: boolean;
  messageTextIndices: Map<number, number>;
  userEntryId: string;
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
    presentation: ReturnType<typeof createSnapshotFirstLivePresentation>;
    subscriptions: Set<AgentLivePresentationSubscription>;
  }>();
  private toolArgsFlushTimer?: ReturnType<typeof setTimeout>;
  protected liveSubscriberCount = 0;
  private readonly livePresentation = createSnapshotFirstLivePresentation((publishToExisting) => {
    if (this.openTextItem()?.final) this.alignTextStreamForSnapshot(publishToExisting);
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
    const subscription = finishNotificationTurn(this.ctx);
    if (subscription) void sendTurnNotification(this.ctx, subscription).catch((error) => {
      console.error("Could not send Agent turn notification", error);
      this.notice("error", "The turn ended, but its push notification could not be sent.");
    });
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
      if (this.liveSubscriberCount === 0 && this.turnSubscriberCount === 0) {
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
        presentation: createSnapshotFirstLivePresentation((publishToExisting) => {
          if (this.live?.working.key === turnId && !this.openTextItem()?.final) this.alignTextStreamForSnapshot(publishToExisting);
          const turn = findTranscriptItem(this.itemsForDisplay(), turnId);
          if (turn?.type !== "working") throw new Error(`Unknown turn: ${turnId}`);
          const html = turboStream("update", ids.workingItems(this.ctx, turnId), renderWorkingContent(this.ctx, turn, { live: turn.live }));
          return async () => html;
        }),
      };
      this.turnPresentations.set(turnId, channel);
    }
    const ownedChannel = channel;
    const subscription = channel.presentation.subscribe(listener);
    let active = true;
    const owned: AgentLivePresentationSubscription = {
      ready: subscription.ready.catch((error) => { owned.unsubscribe(); throw error; }),
      unsubscribe: () => {
        if (!active) return;
        active = false;
        subscription.unsubscribe();
        ownedChannel.subscriptions.delete(owned);
        if (ownedChannel.subscriptions.size === 0 && this.turnPresentations.get(turnId) === ownedChannel) this.turnPresentations.delete(turnId);
        if (this.liveSubscriberCount === 0 && this.turnSubscriberCount === 0) {
          this.cancelTextFlush();
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
  }

  protected get turnSubscriberCount(): number {
    return this.live ? this.turnPresentations.get(this.live.working.key)?.subscriptions.size ?? 0 : 0;
  }

  private streamTurn(html?: string, kind?: "paced-text", turnId = this.live?.working.key): void {
    if (this.disposed || !turnId) return;
    this.turnPresentations.get(turnId)?.presentation.publish(html, kind ? { kind } : undefined);
  }

  private itemIsOutside(item: TranscriptItem): boolean {
    return (item.type === "user" && !item.steering) || item.type === "error" || item.type === "note" || (item.type === "text" && item.final);
  }

  private streamItem(item: TranscriptItem, html: string): void {
    if (this.itemIsOutside(item)) this.stream(html);
    else this.streamTurn(html);
  }

  protected livePendingUser(key: string, text: string, images: SessionImageRef[] = []): void {
    const item: Extract<TranscriptItem, { type: "user" }> = { type: "user", key, text, images, timestamp: Date.now(), pending: true };
    this.pendingUsers.set(key, item);
    this.stream(turboStream("append", ids.transcript(this.ctx), renderTranscriptItem(this.ctx, item)));
  }

  protected liveConsumePendingUser(key: string): void {
    this.pendingUsers.delete(key);
    this.stream(turboStream("remove", ids.item(this.ctx, key)));
  }

  protected stream(html: string): void {
    if (this.disposed) return;
    this.livePresentation.publish(html);
  }

  private streamText(html?: string): void {
    if (this.disposed) return;
    if (this.openTextItem()?.final) this.livePresentation.publish(html, { kind: "paced-text" });
    else this.streamTurn(html, "paced-text");
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
    this.resetTurnSubscriptions(this.ctx.branchId ?? "");
    finishNotificationTurn(this.ctx);
    this.cancelToolArgsFlush();
    return true;
  }

  protected setBusy(busy: boolean): void {
    if (this.announcedBusy === busy) return;
    this.announcedBusy = busy;
    if (busy) startNotificationTurn(this.ctx, () => {
      this.stream(notificationControlTurboStream(this.ctx, this.isStreaming));
    });
    this.stream(notificationControlTurboStream(this.ctx, busy));
    publishWorkspaceViewBusy({ workspaceId: this.workspaceId, viewKey: `agent:${this.conversationId}`, busy });
    this.stream(turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, busy)));
  }

  protected notice(level: "info" | "error", message: string): void {
    this.livePresentation.publish(turboStream("append", ids.notices(this.ctx), renderNotice(level, message)), { kind: "ephemeral" });
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
      this.stream(turboStream("append", ids.transcript(this.ctx), renderTranscriptItem(this.ctx, item, { live: true })));
    }
    this.stream(turboStream("append", ids.transcript(this.ctx), this.renderLiveWorkingSection(live)));
  }

  protected liveSteeringUser(entryId: string, user: { text: string; images: SessionImageRef[] }, pendingKey?: string): void {
    const live = this.liveEnsure();
    const item: TranscriptItem = { type: "user", key: entryId, rewindEntryId: entryId, timestamp: Date.now(), ...user, steering: true };
    live.working.inputEntryIds!.push(entryId);
    live.items.push(item);
    if (pendingKey) this.liveConsumePendingUser(pendingKey);
    this.appendLiveItem(item);
    const section = this.decorateTranscript([this.liveWorkingSection(live)]).find((item) => item.type === "working")!;
    this.stream(turboStream("replace", ids.itemSummaryContent(this.ctx, section.key), renderWorkingSummary(this.ctx, section), { method: "morph" }));
  }

  protected liveEnsure(): LiveState {
    if (!this.live) throw new Error("Assistant activity has no consumed turn entry");
    return this.live;
  }

  protected liveTiming(): WorkingTranscriptItem["timing"] { return this.live?.working.timing; }

  private liveWorkingSection(live: LiveState): WorkingTranscriptItem {
    return { ...live.working, timing: this.liveTiming(), items: [...live.innerNotices, ...live.items.filter((item) => !this.itemIsOutside(item))] };
  }

  private renderLiveWorkingSection(live: LiveState): string {
    const item = findTranscriptItem(this.itemsForDisplay(), live.working.key)!;
    return renderTranscriptItem(this.ctx, item);
  }

  protected liveItemsForDisplay(live: LiveState): TranscriptItem[] {
    const user = live.items.filter((item) => item.key === live.userEntryId);
    const trailing = live.items.filter((item) => item.key !== live.userEntryId && this.itemIsOutside(item));
    return [...user, this.liveWorkingSection(live), ...trailing];
  }

  private appendLiveItem(item: TranscriptItem, options: { live?: boolean; open?: boolean } = {}): void {
    item.timestamp ??= Date.now();
    const target = this.itemIsOutside(item) ? ids.transcript(this.ctx) : ids.workingItems(this.ctx, this.live!.working.key);
    this.streamItem(item, turboStream("append", target, renderTranscriptItem(this.ctx, item, options)));
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
    if (!streamState || streamState.timer || (this.openTextItem()?.final ? this.liveSubscriberCount : this.turnSubscriberCount) === 0) return;
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
    if (this.turnSubscriberCount === 0) {
      this.streamTurn();
      return;
    }
    const content = renderActiveToolContent(this.ctx, item.key, item.tool);
    const summary = turboStream("update", ids.itemSummaryContent(this.ctx, item.key), content.summary);
    // Preserve the tool body across deltas to avoid WebKit flashing while following the bottom.
    const detail = content.detail === undefined ? "" : turboStream("update", ids.detailFrame(this.ctx, item.key), content.detail, { method: "morph" });
    const metadata = turboStream("update", ids.itemSummaryMetadata(this.ctx, item.key), content.metadata);
    this.streamTurn(summary + metadata + detail);
  }

  private finishOpenText(final = false): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "text") return;
    const item = live.items[live.open.index];
    this.releaseTextStream();
    if (item?.type === "text") {
      item.live = false;
      item.final = final;
      this.streamItem(item, turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item)));
    }
    live.open = undefined;
  }

  private finishOpenThinking(): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "thinking") return;
    const item = live.items[live.open.index];
    if (item?.type === "thinking") {
      item.live = false;
      this.streamTurn(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { open: true })));
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
        this.releaseTextStream();
        this.streamTurn(turboStream("remove", ids.item(this.ctx, item.key)));
        item.final = true;
        live.textStream = { displayedLength: item.text.length, renderer: new StreamingMarkdownRenderer(this.workspaceId) };
        live.textStream.renderer.sync(item.text);
        this.stream(turboStream("append", ids.transcript(this.ctx), renderTranscriptItem(this.ctx, item, { live: true })));
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
    this.streamTurn(turboStream("update", ids.itemText(this.ctx, item.key), escapeHtml(item.text)));
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
    this.streamTurn();
    if (this.turnSubscriberCount === 0 || this.toolArgsFlushTimer) return;
    // An already scheduled flush may finish at the fast cadence; subsequent flushes
    // use the accumulated UTF-8 argument size, without postponing work on every delta.
    const intervalMs = Buffer.byteLength(item.tool.argsStream, "utf8") >= largeToolArgsBytes
      ? largeToolArgsFlushIntervalMs
      : liveContentFlushIntervalMs;
    this.toolArgsFlushTimer = setTimeout(() => {
      this.toolArgsFlushTimer = undefined;
      this.streamActiveToolContent(item);
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
    const previousKey = item.key;
    item.key = `tool:${callId}`;
    item.tool.callId = callId;
    item.tool.name = name;
    item.tool.args = args;
    item.tool.status = "running";
    item.tool.argsStream = undefined;
    item.tool.startedAt = Date.now();
    if (name === "bash") item.tool.timeoutSeconds = bashTimeoutSeconds(args);
    live.toolIndexByCallId.set(callId, index);
    if (streamedIndex !== undefined) {
      // Replace the provisional argument row as soon as Pi supplies its call ID.
      // Every later detail URL then uses the same identity as persisted history.
      this.streamTurn(turboStream("replace", ids.item(this.ctx, previousKey), renderTranscriptItem(this.ctx, item, { live: true, open: true })));
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
    this.streamTurn();
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
    item.tool.status = isError || toolDetailsIndicateError(details) ? "error" : "ok";
    item.tool.resultText = resultText;
    item.tool.details = details;
    item.tool.tmuxSession = undefined;
    item.tool.terminalVisible = undefined;
    const presentation = toolPresentation(item.tool);
    if (wasShowingDetail !== presentation.showsDetail) {
      this.streamTurn(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { live: true, open: presentation.autoOpenOnReveal })));
    } else {
      this.streamActiveToolContent(item);
    }
  }

  protected liveNote(text: string, tone: "system" | "summary" | "error"): void {
    const live = this.liveEnsure();
    this.closeOpenItem();
    const item: TranscriptItem = tone === "error"
      ? { type: "error", key: this.liveKey(live, live.items.length, "error"), text }
      : { type: "note", key: this.liveKey(live, live.items.length, "note"), text, tone };
    live.items.push(item);
    this.appendLiveItem(item, { live: true });
  }

  protected liveAssistantFailure(): void {
    const live = this.live;
    if (!live) return;
    this.closeOpenItem();
    for (const index of live.messageTextIndices.values()) {
      const item = live.items[index];
      if (item?.type !== "text" || !item.final) continue;
      this.stream(turboStream("remove", ids.item(this.ctx, item.key)));
      item.final = false;
      this.streamTurn(turboStream("append", ids.workingItems(this.ctx, live.working.key), renderTranscriptItem(this.ctx, item)));
    }
    live.finalStarted = false;
  }

  protected liveInnerError(text: string): void {
    const live = this.liveEnsure();
    this.closeOpenItem();
    const item: TranscriptItem = { type: "error", key: this.liveKey(live, live.innerNotices.length, "retry"), text };
    live.innerNotices.push(item);
    this.streamTurn(turboStream("append", ids.workingItems(this.ctx, live.working.key), renderTranscriptItem(this.ctx, item)));
  }

  protected liveFinal(text: string, contentIndexes?: number[]): void {
    const live = this.live;
    if (!live) return;
    this.releaseTextStream();
    live.open = undefined;
    const selected = new Set(contentIndexes ?? live.messageTextIndices.keys());
    const removeIndices = new Set([...live.messageTextIndices].filter(([contentIndex]) => selected.has(contentIndex)).map(([, index]) => index));
    for (const index of removeIndices) {
      const item = live.items[index]!;
      this.streamItem(item, turboStream("remove", ids.item(this.ctx, item.key)));
    }
    live.items = live.items.filter((_, index) => !removeIndices.has(index));
    // All tools in this assistant message have completed before a final answer.
    live.toolIndexByCallId.clear();
    live.messageTextIndices.clear();
    const index = live.items.length;
    const item: TranscriptItem = { type: "text", key: this.liveKey(live, index, "final"), text, final: true };
    live.finalStarted = true;
    live.items.push(item);
    this.appendLiveItem(item);
  }

  protected liveCacheMiss(miss: CacheMiss): void {
    const text = significantCacheMissNotice(miss);
    if (!text) return;
    const live = this.liveEnsure();
    const item: TranscriptItem = { type: "note", key: this.liveKey(live, live.items.length, "cache-miss"), text, tone: "warning" };
    live.items.push(item);
    this.appendLiveItem(item);
  }

  /** End the live model synchronously; terminal lifecycle must not wait on stats I/O. */
  protected finishLivePresentation(outcome: "completed" | "stopped" = "stopped"): void {
    this.cancelToolArgsFlush();
    // Supersede any paced tail with one canonical full-source render before the
    // live state (and its renderer session) is discarded.
    this.finishOpenText(Boolean(this.openTextItem()?.final));
    this.releaseTextStream();
    if (this.live) {
      for (const timer of this.live.terminalTimers.values()) clearTimeout(timer);
      if (outcome === "completed") this.live.working.completedAt = Date.now();
      else this.live.working.stoppedAt = Date.now();
      const turn = this.decorateTranscript([this.liveWorkingSection(this.live)]).find((item) => item.type === "working")!;
      this.stream(turboStream("replace", ids.itemSummaryContent(this.ctx, turn.key), renderWorkingSummary(this.ctx, turn), { method: "morph" }));
      this.streamTurn(turboStream("update", ids.workingItems(this.ctx, turn.key), renderWorkingContent(this.ctx, turn)));
    }
    this.live = undefined;
  }

  protected decorateTranscript(items: TranscriptItem[]): TranscriptItem[] { return items; }

  private contributions = { rows: new Map<string, ContributedRow>(), summaries: new Map<string, string>() };

  private contributionsForDisplay() {
    const rows = new Map<string, ContributedRow>();
    const summaries = new Map<string, string>();
    const visit = (items: TranscriptItem[], parent: string, turnId?: string) => {
      for (const [index, item] of items.entries()) {
        if (item.type === "working") {
          summaries.set(ids.itemSummaryContent(this.ctx, item.key), renderWorkingSummary(this.ctx, item));
          visit(item.items, ids.workingItems(this.ctx, item.key), item.key);
        }
        if (item.type !== "extension") continue;
        rows.set(ids.item(this.ctx, item.key), {
          html: renderTranscriptItem(this.ctx, item), parent, turnId,
          next: items[index + 1] ? ids.item(this.ctx, items[index + 1]!.key) : undefined,
        });
      }
    };
    visit(this.itemsForDisplay(), ids.transcript(this.ctx));
    return { rows, summaries };
  }

  protected captureContributedRows(): void {
    this.contributions = this.contributionsForDisplay();
  }

  /** Reconcile contributed rows and run summaries without replacing host text/tool streams. */
  protected refreshContributedRows(): void {
    const current = this.contributionsForDisplay();
    const updates = new Map<string | undefined, string>();
    const append = (turnId: string | undefined, html: string): void => { updates.set(turnId, (updates.get(turnId) ?? "") + html); };
    for (const [id, previous] of this.contributions.rows) {
      if (!current.rows.has(id)) append(previous.turnId, turboStream("remove", id));
    }
    // Insert backwards so a new row's next sibling already exists.
    for (const [id, item] of [...current.rows].reverse()) {
      const previous = this.contributions.rows.get(id);
      const moved = previous !== undefined && (previous.parent !== item.parent || previous.next !== item.next);
      if (previous?.html === item.html && !moved) continue;
      if (moved) append(previous.turnId, turboStream("remove", id));
      if (previous === undefined) append(item.turnId, turboStream("remove", id));
      append(item.turnId, previous !== undefined && !moved
        ? turboStream("replace", id, item.html)
        : item.next ? turboStream("before", item.next, item.html) : turboStream("append", item.parent, item.html));
    }
    for (const [id, html] of current.summaries) {
      if (this.contributions.summaries.get(id) !== html) append(undefined, turboStream("replace", id, html, { method: "morph" }));
    }
    this.contributions = current;
    for (const [turnId, html] of updates) {
      if (turnId) this.streamTurn(html, undefined, turnId);
      else this.stream(html);
    }
  }

  private itemsForDisplay(): TranscriptItem[] {
    let items = this.canonicalItems();
    const live = this.live;
    if (!live) return [...this.decorateTranscript(items), ...this.pendingUsers.values()];
    const index = items.findIndex((item) => item.key === live.userEntryId || item.key === live.working.key);
    if (index >= 0) items = items.slice(0, index);
    return [...this.decorateTranscript([...items, ...this.liveItemsForDisplay(live)]), ...this.pendingUsers.values()];
  }

  protected async refreshTranscript(): Promise<void> {
    this.captureContributedRows();
    await this.streamRendered(async () => turboStream("update", ids.transcript(this.ctx), renderTranscript(this.ctx, this.itemsForDisplay(), this.modelContext())));
  }

  protected async refreshStats(): Promise<void> {
    await this.streamRendered(async () => turboStream("update", ids.stats(this.ctx), renderAgentPaneComposerFooter(this.ctx, await this.statsView())));
  }

  private capturePaneState(revealTarget?: string): () => Promise<AgentPaneState> {
    // The transcript and busy flag are the mutable live boundary. Capture both
    // synchronously before stats performs any configuration or provider I/O.
    this.captureContributedRows();
    const transcriptHtml = renderTranscript({ ...this.ctx, revealTarget }, this.itemsForDisplay(), this.modelContext());
    const busy = this.isStreaming;
    const stats = this.statsView();
    return async () => ({ transcriptHtml, busy, stats: await stats });
  }

  private captureAuthoritativePresentationUpdate(): () => Promise<string> {
    const completeState = this.capturePaneState();
    const notificationHtml = notificationControlTurboStream(this.ctx, this.isStreaming);
    return async () => {
      const state = await completeState();
      return notificationHtml
        + turboStream("update", ids.transcript(this.ctx), state.transcriptHtml)
        + turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, state.busy))
        + turboStream("update", ids.stats(this.ctx), renderAgentPaneComposerFooter(this.ctx, state.stats));
    };
  }

  protected async authoritativePresentationUpdate(): Promise<string> {
    return await this.captureAuthoritativePresentationUpdate()();
  }

  async paneState(revealTarget?: string): Promise<AgentPaneState> {
    this.assertActive();
    return await this.capturePaneState(revealTarget)();
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

