import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AtelierCoreError, isJsonObject, shellQuote, type AtelierEventBus, type JsonObject } from "@atelier/core";
import { StreamingMarkdownRenderer } from "@atelier/markdown";
import { execWorkspaceCommand, workspaceRoot } from "@atelier/workspace";
import { createPiModelRuntime, getConfiguredAgentModels, getModelThinkingLevel } from "./pi-config-models.ts";
import { preferredNewWorkspaceAgentModel } from "./model-state.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
  type CompactionEntry,
} from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";
import { escapeHtml, turboStream } from "./html.ts";
import {
  ids,
  renderNotice,
  renderModelContextDetailFrame,
  renderActiveToolContent,
  renderObservedBashCompletion,
  renderObservedBashTabs,
  renderPromptActions,
  renderStatsBar,
  renderToolSummary,
  renderTranscript,
  renderTranscriptItem,
  renderTranscriptItemDetailFrame,
  type AgentPaneState,
  type AgentModelContextView,
  type AgentRenderContext,
  type AgentStatsView,
  type AgentToolDefinitionView,
} from "./render.ts";
import { replaceWorkspaceAgentSession, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import { renderAgentSessionTree, updateAgentSessionTreeLabel, type TreeFilterMode } from "./session-tree.ts";
import { loadWorkspaceSkills } from "./skills.ts";
import { atelierSystemPrompt, createAtelierResourceLoader } from "./system-prompt.ts";
import { collectCacheMisses, detectCacheMiss, significantCacheMissNotice, type CacheMiss } from "./cache-miss.ts";
import { AgentServiceTierState, modelRuntimeWithServiceTiers, supportsFastMode, type AgentServiceTier } from "./service-tier.ts";
import { createWorkspaceAgentTools, workspaceAgentToolNames } from "./tools.ts";
import {
  buildTranscript,
  isFinalAssistantMessage,
  isFinalAssistantStopReason,
  isToolViewDetails,
  toolDetailsIndicateError,
  type ImageRef,
  type SessionImageRef,
  type TranscriptItem,
  type WorkingTranscriptItem,
  type ToolViewDetails,
  type ToolView,
  type TranscriptRecord,
} from "./transcript.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

type AgentSubscriber = (streamHtml: string, cursor: string) => void;
type WorkspaceViewBusyListener = (event: { workspaceId: string; viewKey: string; busy: boolean }) => void;
type InitialSessionSettings = Pick<NonNullable<Parameters<typeof createAgentSession>[0]>, "model" | "thinkingLevel"> & { serviceTier?: AgentServiceTier };

const workspaceViewBusyListeners = new Set<WorkspaceViewBusyListener>();

export function subscribeWorkspaceViewBusy(listener: WorkspaceViewBusyListener): () => void {
  workspaceViewBusyListeners.add(listener);
  return () => workspaceViewBusyListeners.delete(listener);
}

export type SubmitMode = "send" | "steer";

interface SubmitOptions {
  mode: SubmitMode;
  images?: ImageRef[];
  /** Extra lines appended to the prompt describing non-image attachments. */
  attachmentNotes?: string[];
}

type RewindMode = "discard" | "summary";

interface WorkspaceAgentRuntime {
  workspaceId: string;
  conversationId: string;
  label: string;
  sessionFile: string;
  readonly isStreaming: boolean;
  subscribe(listener: AgentSubscriber): () => void;
  /** Turbo-stream HTML bringing a fresh client fully up to date, unless it already has this snapshot. */
  snapshotStream(upTo?: string): Promise<{ html: string; cursor: string }>;
  /** Server-rendered state for initial pane HTML. */
  paneState(): Promise<AgentPaneState>;
  userMessages(): string[];
  submit(text: string, options: SubmitOptions): Promise<void>;
  compact(customInstructions?: string): Promise<void>;
  abort(): Promise<void>;
  currentModel(): { provider: string; id: string } | undefined;
  currentThinkingLevel(): string;
  availableThinkingLevels(): string[];
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  setServiceTier(serviceTier: AgentServiceTier): Promise<void>;
  rewind(entryId: string, mode: RewindMode, customInstructions?: string): Promise<void>;
  treeHtml(options: { filter: TreeFilterMode; query: string }): string;
  labelTreeEntry(entryId: string, label: string, operation: "add" | "remove"): void;
  navigateTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string>;
  newSession(): Promise<void>;
  detailHtml(key: string, count?: number): Promise<string>;
}

const runtimes = new Map<string, Promise<WorkspaceAgentRuntime>>();
const readyRuntimeKeys = new Set<string>();
const removedWorkspaceIds = new Set<string>();

function runtimeKey(workspaceId: string, label: string): string {
  return `${workspaceId}\u0000${label}`;
}

interface WorkspaceAgentRuntimeOptions {
  events?: AtelierEventBus;
}

export function isWorkspaceAgentRuntimeReady(agent: WorkspaceAgentConversationInfo): boolean {
  return readyRuntimeKeys.has(runtimeKey(agent.workspaceId, agent.label));
}

export async function removeWorkspaceAgentRuntimes(workspaceId: string): Promise<void> {
  removedWorkspaceIds.add(workspaceId);
  const matching = [...runtimes.entries()].filter(([key]) => key.startsWith(`${workspaceId}\u0000`));
  for (const [key] of matching) {
    runtimes.delete(key);
    readyRuntimeKeys.delete(key);
  }
  const settled = await Promise.allSettled(matching.map(([, runtime]) => runtime));
  await Promise.all(settled.flatMap((result) => result.status === "fulfilled" ? [result.value.abort()] : []));
}

export function getWorkspaceAgentRuntime(agent: WorkspaceAgentConversationInfo, options: WorkspaceAgentRuntimeOptions = {}): Promise<WorkspaceAgentRuntime> {
  if (removedWorkspaceIds.has(agent.workspaceId)) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${agent.workspaceId}`);
  const key = runtimeKey(agent.workspaceId, agent.label);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRealRuntime(agent, options).then((created) => {
      readyRuntimeKeys.add(key);
      return created;
    }, (error) => {
      runtimes.delete(key);
      readyRuntimeKeys.delete(key);
      throw error;
    });
    runtimes.set(key, runtime);
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// Base runtime: subscriber fanout and live transcript streaming.
// ---------------------------------------------------------------------------

interface LiveTextStream {
  displayedLength: number;
  renderer: StreamingMarkdownRenderer;
  timer?: ReturnType<typeof setTimeout>;
}

interface LiveState {
  id: string;
  items: TranscriptItem[];
  working: Omit<WorkingTranscriptItem, "items">;
  finalIndex?: number;
  userEntryId?: string;
  open?: { index: number; kind: "text" | "thinking" | "toolargs" };
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
const assistantTextFlushIntervalMs = 16;
const assistantTextCharactersPerFlush = 24;
// Pi's 20k default makes manual compaction a no-op for many substantial
// Atelier sessions. Keep enough recent context while allowing an explicit
// /compact to summarize medium-length conversations.
const compactionKeepRecentTokens = 6000;

export function contextUsagePercent(measured: number | null | undefined, estimatedTokens: number | undefined, contextWindow: number | undefined): number | null {
  return measured ?? (estimatedTokens !== undefined && contextWindow ? estimatedTokens / contextWindow * 100 : null);
}

abstract class BaseAgentRuntime implements WorkspaceAgentRuntime {
  workspaceId: string;
  conversationId: string;
  title: string;
  label: string;
  sessionFile: string;
  protected ctx: AgentRenderContext;
  protected live?: LiveState;
  private announcedBusy = false;
  private subscribers = new Set<AgentSubscriber>();
  private readonly snapshotGeneration = crypto.randomUUID();
  private snapshotRevision = 0;

  constructor(agent: WorkspaceAgentConversationInfo, protected readonly options: WorkspaceAgentRuntimeOptions = {}) {
    this.workspaceId = agent.workspaceId;
    this.conversationId = agent.conversationId;
    this.title = agent.title;
    this.label = agent.label;
    this.sessionFile = agent.path;
    this.ctx = { workspaceId: agent.workspaceId, label: agent.label };
  }

  protected async emitTurnFinished(): Promise<void> {
    await this.options.events?.emit("workspace_agent_turn_finished", { workspaceId: this.workspaceId, agentLabel: this.label });
  }

  get isStreaming(): boolean {
    return this.announcedBusy;
  }

  subscribe(listener: AgentSubscriber): () => void {
    const wasEmpty = this.subscribers.size === 0;
    this.subscribers.add(listener);
    if (wasEmpty) this.alignTextStreamWithAuthoritativeSnapshot();
    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0) this.cancelTextFlush();
    };
  }

  private snapshotCursor(): string {
    return `${this.snapshotGeneration}:${this.snapshotRevision}`;
  }

  private markSnapshotMutation(): void {
    this.snapshotRevision += 1;
  }

  protected stream(html: string): void {
    this.markSnapshotMutation();
    const cursor = this.snapshotCursor();
    for (const subscriber of this.subscribers) subscriber(html, cursor);
  }

  protected setBusy(busy: boolean): void {
    if (this.announcedBusy === busy) return;
    this.announcedBusy = busy;
    for (const listener of workspaceViewBusyListeners) listener({ workspaceId: this.workspaceId, viewKey: `agent:${this.label}`, busy });
    this.stream(turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, busy)));
  }

  protected notice(level: "info" | "error", message: string): void {
    this.stream(turboStream("append", ids.notices(this.ctx), renderNotice(level, message)));
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
      working: { type: "working", key: `${id}:working`, startedAt: now, live: true },
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
    return { ...live.working, items: live.items.slice(userIndex, end) };
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

  private alignTextStreamWithAuthoritativeSnapshot(): void {
    const item = this.openTextItem();
    const streamState = this.live?.textStream;
    if (!item || !streamState) return;
    this.cancelTextFlush();
    streamState.renderer.sync(item.text);
    streamState.displayedLength = item.text.length;
  }

  private scheduleTextFlush(): void {
    const streamState = this.live?.textStream;
    if (!streamState || streamState.timer || this.subscribers.size === 0) return;
    streamState.timer = setTimeout(() => {
      streamState.timer = undefined;
      this.flushTextChunk();
    }, assistantTextFlushIntervalMs);
  }

  private flushTextChunk(): void {
    const item = this.openTextItem();
    const streamState = this.live?.textStream;
    if (!item || !streamState) return;
    const nextLength = Math.min(item.text.length, streamState.displayedLength + assistantTextCharactersPerFlush);
    if (nextLength === streamState.displayedLength) return;
    const update = streamState.renderer.render(item.text.slice(0, nextLength));
    streamState.displayedLength = nextLength;
    const stable = update.stableHtmlAddition
      ? turboStream("append", ids.itemTextStable(this.ctx, item.key), update.stableHtmlAddition)
      : "";
    this.stream(stable + turboStream("update", ids.itemTextTail(this.ctx, item.key), update.tailHtml));
    if (streamState.displayedLength < item.text.length) this.scheduleTextFlush();
  }

  private releaseTextStream(): void {
    this.cancelTextFlush();
    if (this.live) this.live.textStream = undefined;
  }

  private streamActiveToolContent(item: Extract<TranscriptItem, { type: "tool" }>): void {
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
      this.stream(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item)));
    }
    live.open = undefined;
  }

  private finishOpenThinking(): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "thinking") return;
    const item = live.items[live.open.index];
    if (item?.type === "thinking") {
      item.live = false;
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
    live.working.completedAt = Date.now();
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
    const working = turboStream("replace", ids.item(this.ctx, live.working.key), renderTranscriptItem(this.ctx, this.liveWorkingSection(live)));
    const final = live.finalIndex === undefined ? "" : turboStream("append", ids.transcript(this.ctx), renderTranscriptItem(this.ctx, live.items[live.finalIndex]!));
    this.stream(working + final);
  }

  protected liveTextDelta(text: string): void {
    const live = this.liveEnsure();
    if (live.open?.kind === "thinking") this.finishOpenThinking();
    if (!live.open || live.open.kind !== "text") {
      const index = live.items.length;
      const final = live.working.completedAt !== undefined;
      const item: TranscriptItem = { type: "text", key: this.liveKey(live, index, "text"), text: "", final, live: true };
      if (final) live.finalIndex = index;
      live.items.push(item);
      live.open = { index, kind: "text" };
      live.textStream = { displayedLength: 0, renderer: new StreamingMarkdownRenderer(this.workspaceId) };
      this.appendLiveItem(item, { live: true });
    }
    const item = live.items[live.open.index];
    if (item?.type !== "text") return;
    item.text += text;
    // Authoritative text changes immediately even though its visible update is
    // paced. Reconnect cursors must therefore advance before the next flush.
    this.markSnapshotMutation();
    this.scheduleTextFlush();
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
    try { item.tool.args = JSON.parse(item.tool.argsStream); } catch { /* partial external JSON */ }
    this.streamActiveToolContent(item);
  }

  protected liveToolCallComplete(call: LiveToolCall): void {
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
      this.stream(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { live: true, open: true })));
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
        this.stream(turboStream("replace", ids.item(this.ctx, revisit.key), renderTranscriptItem(this.ctx, revisit, { live: true, open: true })));
      }, terminalRevealMs);
      live.terminalTimers.set(callId, timer);
    }
    if (update.outputText !== undefined) item.tool.resultText = update.outputText;
    if (update.details !== undefined) item.tool.details = update.details;
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
    item.tool.durationMs = item.tool.startedAt ? Date.now() - item.tool.startedAt : undefined;
    item.tool.status = isError || toolDetailsIndicateError(details) ? "error" : "ok";
    item.tool.resultText = resultText;
    item.tool.details = details;
    if (item.tool.name === "bash" && item.tool.terminalVisible) {
      this.stream(turboStream("replace", ids.itemSummary(this.ctx, item.key), renderToolSummary(this.ctx, item.key, item.tool)));
      this.stream(turboStream("update", ids.itemCompletionTabs(this.ctx, item.key), renderObservedBashTabs(item.key, item.tool)));
      this.stream(turboStream("update", ids.itemCompletion(this.ctx, item.key), renderObservedBashCompletion(this.ctx, item.key, item.tool)));
    } else {
      item.tool.tmuxSession = undefined;
      this.stream(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { live: true, open: true })));
    }
  }

  protected liveNote(text: string, tone: "system" | "summary" | "error"): void {
    const live = this.liveEnsure();
    this.closeOpenItem();
    const item: TranscriptItem = { type: "note", key: this.liveKey(live, live.items.length, "note"), text, tone };
    live.items.push(item);
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

  protected liveCacheMiss(miss: CacheMiss): void {
    const text = significantCacheMissNotice(miss);
    if (!text) return;
    const live = this.liveEnsure();
    const item: TranscriptItem = { type: "note", key: this.liveKey(live, live.items.length, "cache-miss"), text, tone: "warning" };
    live.items.push(item);
    this.appendLiveItem(item, { live: true });
  }

  /** End the live model; observed tool calls stay open. */
  protected async liveEnd(): Promise<void> {
    // Supersede any paced tail with one canonical full-source render before the
    // live state (and its renderer session) is discarded.
    this.finishOpenText(false);
    this.releaseTextStream();
    if (this.live) {
      for (const timer of this.live.terminalTimers.values()) clearTimeout(timer);
      if (this.live.working.completedAt === undefined) {
        this.live.working.stoppedAt = Date.now();
        this.stream(turboStream("replace", ids.item(this.ctx, this.live.working.key), renderTranscriptItem(this.ctx, this.liveWorkingSection(this.live))));
      }
    }
    this.live = undefined;
    await this.refreshStats();
  }

  private async itemsForDisplay(): Promise<TranscriptItem[]> {
    let items = await this.canonicalItems();
    const live = this.live;
    if (!live) return items;
    if (live.userEntryId) {
      const index = items.findIndex((item) => item.rewindEntryId === live.userEntryId || item.key === live.userEntryId);
      if (index >= 0) items = items.slice(0, index);
    }
    return [...items, ...this.liveItemsForDisplay(live)];
  }

  protected async refreshTranscript(): Promise<void> {
    this.stream(turboStream("update", ids.transcript(this.ctx), renderTranscript(this.ctx, await this.itemsForDisplay(), this.modelContext())));
  }

  protected async refreshStats(): Promise<void> {
    this.stream(turboStream("update", ids.stats(this.ctx), renderStatsBar(this.ctx, await this.statsView())));
  }

  async snapshotStream(upTo?: string): Promise<{ html: string; cursor: string }> {
    const cursor = this.snapshotCursor();
    if (upTo === cursor) return { html: "", cursor };
    const state = await this.paneState();
    const html = turboStream("update", ids.transcript(this.ctx), state.transcriptHtml) + turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, state.busy)) + turboStream("update", ids.stats(this.ctx), renderStatsBar(this.ctx, state.stats));
    return { html, cursor: state.snapshotCursor! };
  }

  async paneState(): Promise<AgentPaneState> {
    // A pane snapshot is authoritative and must never be followed by an older
    // paced update from this runtime.
    this.alignTextStreamWithAuthoritativeSnapshot();
    const snapshotCursor = this.snapshotCursor();
    return { transcriptHtml: renderTranscript(this.ctx, await this.itemsForDisplay(), this.modelContext()), busy: this.isStreaming, stats: await this.statsView(), snapshotCursor };
  }

  async detailHtml(key: string, count = 100): Promise<string> {
    if (key === "model-context") return renderModelContextDetailFrame(this.ctx, this.modelContext());
    const item = (await this.itemsForDisplay()).find((candidate) => candidate.key === key);
    return item ? renderTranscriptItemDetailFrame(this.ctx, item, { count }) : "";
  }

  protected abstract modelContext(): AgentModelContextView;
  abstract userMessages(): string[];
  protected abstract canonicalItems(leafId?: string): Promise<TranscriptItem[]>;
  protected abstract statsView(): Promise<AgentStatsView>;
  abstract submit(text: string, options: SubmitOptions): Promise<void>;
  abstract compact(customInstructions?: string): Promise<void>;
  abstract abort(): Promise<void>;
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

// ---------------------------------------------------------------------------
// Real runtime (pi agent SDK)
// ---------------------------------------------------------------------------

interface ImageDimensions {
  width: number;
  height: number;
}

function imageDimensions(data: Uint8Array, mimeType: string): ImageDimensions | undefined {
  if (mimeType === "image/png" && data.length >= 24) return { width: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(16), height: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(20) };
  if (mimeType === "image/gif" && data.length >= 10) return { width: data[6]! | data[7]! << 8, height: data[8]! | data[9]! << 8 };
  if (mimeType === "image/bmp" && data.length >= 26) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (mimeType === "image/webp" && data.length >= 30 && String.fromCharCode(...data.slice(12, 16)) === "VP8X") {
    const width = 1 + data[24]! + (data[25]! << 8) + (data[26]! << 16);
    const height = 1 + data[27]! + (data[28]! << 8) + (data[29]! << 16);
    return { width, height };
  }
  if (mimeType === "image/jpeg") {
    for (let offset = 2; offset + 8 < data.length;) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1]!;
      const length = data[offset + 2]! << 8 | data[offset + 3]!;
      if (marker >= 0xc0 && marker <= 0xc3) return { height: data[offset + 5]! << 8 | data[offset + 6]!, width: data[offset + 7]! << 8 | data[offset + 8]! };
      offset += 2 + length;
    }
  }
  return undefined;
}

const sessionImagePartSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.Optional(Type.Unknown()),
  data: Type.Optional(Type.Unknown()),
});
const sessionImageStringSchema = Type.String();
const sessionTimestampSchema = Type.Number();

function sessionContentImages(entry: { id: string; message?: { content?: unknown } }): SessionImageRef[] {
  if (!Array.isArray(entry.message?.content)) return [];
  const images: SessionImageRef[] = [];
  entry.message.content.forEach((part, contentIndex) => {
    if (!Value.Check(sessionImagePartSchema, part)) return;
    const mimeType = Value.Check(sessionImageStringSchema, part.mimeType) ? part.mimeType : undefined;
    const data = Value.Check(sessionImageStringSchema, part.data) ? part.data : undefined;
    const dimensions = data && mimeType ? imageDimensions(Buffer.from(data.slice(0, 87_384), "base64"), mimeType) : undefined;
    images.push({ entryId: entry.id, contentIndex, mimeType, ...dimensions });
  });
  return images;
}

function entryTimestamp(entry: { timestamp?: string }, message?: { timestamp?: unknown }): number {
  if (Value.Check(sessionTimestampSchema, message?.timestamp)) {
    // pi stores seconds or ms depending on producer; normalize to ms.
    return message.timestamp > 10_000_000_000 ? message.timestamp : message.timestamp * 1000;
  }
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function recordsFromSessionEntries(entries: any[], cacheMisses = new Map<any, CacheMiss>()): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (!message) continue;
      if (message.role === "user") {
        records.push({ kind: "user", id: entry.id, text: contentText(message.content), images: sessionContentImages(entry), timestamp: entryTimestamp(entry, message), rewindable: entry.parentId !== null && entry.parentId !== undefined });
      } else if (message.role === "assistant") {
        const parts: any[] = [];
        for (const part of message.content ?? []) {
          if (part.type === "thinking") parts.push({ type: "thinking", text: part.thinking ?? "" });
          else if (part.type === "text") parts.push({ type: "text", text: part.text ?? "" });
          else if (part.type === "toolCall") parts.push({ type: "toolCall", callId: part.id, name: part.name, args: part.arguments });
        }
        records.push({
          kind: "assistant",
          id: entry.id,
          parts,
          stopReason: message.stopReason ?? "stop",
          errorMessage: message.errorMessage,
          timestamp: entryTimestamp(entry, message),
        });
        const notice = significantCacheMissNotice(cacheMisses.get(message));
        if (notice && message.stopReason !== "aborted" && message.stopReason !== "error") {
          records.push({ kind: "note", text: notice, tone: "warning", timestamp: entryTimestamp(entry, message) });
        }
      } else if (message.role === "toolResult") {
        const details = isToolViewDetails(message.details) ? message.details : undefined;
        records.push({ kind: "toolResult", callId: message.toolCallId, text: contentText(message.content), images: sessionContentImages(entry), isError: Boolean(message.isError), timestamp: entryTimestamp(entry, message), details });
      } else if (message.role === "bashExecution") {
        records.push({ kind: "note", id: entry.id, text: `\`$ ${message.command}\`\n\n\`\`\`\n${message.output ?? ""}\n\`\`\``, tone: "system", timestamp: entryTimestamp(entry, message) });
      } else if (message.role === "custom" && message.display) {
        records.push({ kind: "note", id: entry.id, text: contentText(message.content), tone: "summary", timestamp: entryTimestamp(entry, message) });
      } else if (message.role === "branchSummary") {
        records.push({ kind: "note", id: entry.id, text: `**Rewound** — summary of the abandoned branch:\n\n${message.summary ?? ""}`, tone: "summary", timestamp: entryTimestamp(entry, message) });
      }
      continue;
    }
    if (entry.type === "branch_summary") {
      records.push({ kind: "note", id: entry.id, text: `**Rewound** — summary of the abandoned branch:\n\n${entry.summary ?? ""}`, tone: "summary", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "compaction") {
      records.push({ kind: "note", id: entry.id, text: "Context compacted", tone: "system", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "custom_message" && entry.display) {
      records.push({ kind: "note", id: entry.id, text: contentText(entry.content), tone: "summary", timestamp: entryTimestamp(entry) });
      continue;
    }
    if (entry.type === "model_change") {
      records.push({ kind: "note", id: entry.id, text: `model → ${entry.provider}/${entry.modelId}`, tone: "system", timestamp: entryTimestamp(entry) });
      continue;
    }
  }
  return records;
}

class RealAgentRuntime extends BaseAgentRuntime {
  private summarizing = false;
  private unsubscribeSession?: () => void;
  private postCompactionEstimate?: { entryId: string; tokens: number };

  constructor(agent: WorkspaceAgentConversationInfo, private session: any, private toolsForModel: AgentToolDefinitionView[], private serviceTiers: AgentServiceTierState, options: WorkspaceAgentRuntimeOptions = {}) {
    super(agent, options);
    this.ctx.model = this.currentModel();
    this.subscribeToSession();
  }

  private subscribeToSession(): void {
    this.unsubscribeSession = this.session.subscribe((event: any) => {
      void this.handleEvent(event);
    });
  }

  override get isStreaming(): boolean {
    return Boolean(this.session.isStreaming || this.summarizing);
  }

  private async configuredModelOptions(): Promise<{ provider: string; id: string; name: string; model: any; available: boolean }[]> {
    // Resolve the configured picker list against Pi's live runtime snapshot.
    const configuredModels = await getConfiguredAgentModels();
    const available = new Set((await this.session.modelRuntime.getAvailable()).map((model: { provider: string; id: string }) => `${model.provider}::${model.id}`));
    return configuredModels.map((configured) => ({
      provider: configured.provider,
      id: configured.id,
      name: configured.label,
      model: this.session.modelRuntime.getModel(configured.provider, configured.id),
      available: available.has(`${configured.provider}::${configured.id}`),
    }));
  }

  protected modelContext(): AgentModelContextView {
    return { systemPrompt: this.session.systemPrompt ?? "", tools: this.toolsForModel };
  }

  currentModel(): { provider: string; id: string } | undefined {
    const model = this.session.model;
    return model?.provider && model?.id ? { provider: model.provider, id: model.id } : undefined;
  }

  currentThinkingLevel(): string {
    return this.session.thinkingLevel ?? "off";
  }

  availableThinkingLevels(): string[] {
    return this.session.supportsThinking?.() ? this.session.getAvailableThinkingLevels() : [];
  }

  private async currentServiceTier(): Promise<AgentServiceTier | undefined> {
    const provider = this.currentModel()?.provider;
    return provider && supportsFastMode(provider) ? await this.serviceTiers.get(provider) : undefined;
  }

  userMessages(): string[] {
    return recordsFromSessionEntries(this.session.sessionManager.getBranch())
      .filter((record) => record.kind === "user")
      .map((record) => record.text);
  }

  protected async canonicalItems(leafId?: string): Promise<TranscriptItem[]> {
    const entries = this.session.sessionManager.getBranch(leafId);
    const cacheMisses = collectCacheMisses(entries, this.session.modelRuntime);
    return buildTranscript(recordsFromSessionEntries(entries, cacheMisses));
  }

  private latestCompactionEntry(): CompactionEntry | undefined {
    return this.session.sessionManager.getBranch().findLast((entry: any) => entry.type === "compaction");
  }

  protected async statsView(): Promise<AgentStatsView> {
    const configuredModels = await this.configuredModelOptions();
    const stats = this.session.getSessionStats?.();
    const context = this.session.getContextUsage?.();
    const model = this.session.model;
    const estimate = this.postCompactionEstimate;
    const estimatedTokens = this.latestCompactionEntry()?.id === estimate?.entryId ? estimate?.tokens : undefined;
    const contextPercent = contextUsagePercent(context?.percent, estimatedTokens, model?.contextWindow);
    const models = configuredModels.map((option) => ({
      provider: option.provider,
      id: option.id,
      name: option.name,
      selected: model ? option.provider === model.provider && option.id === model.id : false,
      available: option.available,
      unavailableReason: option.available ? undefined : "Provider disconnected",
    }));
    // Current model outside the configured list: show it as a selected extra entry.
    if (model && !models.some((option) => option.selected)) {
      // Show the current session model for accuracy, but do not offer it as a
      // selectable choice unless it is also in the user's favorites list.
      models.unshift({ provider: model.provider, id: model.id, name: model.name ?? model.id, selected: true, available: false, unavailableReason: "Not in favorite models" });
    }
    return {
      contextPercent,
      inputTokens: stats?.tokens?.input ?? 0,
      outputTokens: stats?.tokens?.output ?? 0,
      cost: stats?.cost ?? 0,
      modelName: model?.name ?? model?.id,
      provider: model?.provider,
      thinkingLevel: this.currentThinkingLevel(),
      thinkingLevels: this.availableThinkingLevels(),
      serviceTier: await this.currentServiceTier(),
      models,
    };
  }

  private latestSessionMessage(predicate: (message: any) => boolean): any | undefined {
    return this.session.sessionManager.getBranch().findLast((entry: any) => entry?.type === "message" && predicate(entry.message));
  }

  private syncLiveUserEntry(): void {
    const live = this.live;
    if (!live || live.userEntryId) return;
    const entry = this.latestSessionMessage((message) => message?.role === "user");
    const user = live.items.find((item): item is Extract<TranscriptItem, { type: "user" }> => item.type === "user");
    if (!entry || !user) return;
    live.userEntryId = entry.id;
    user.rewindEntryId = entry.id;
    user.images = sessionContentImages(entry);
    this.stream(turboStream("replace", ids.item(this.ctx, user.key), renderTranscriptItem(this.ctx, user, { live: true })));
  }

  private syncLiveToolResult(callId: string): void {
    const live = this.live;
    const itemIndex = live?.toolIndexByCallId.get(callId);
    if (!live || itemIndex === undefined) return;
    const item = live.items[itemIndex];
    if (item?.type !== "tool") return;
    const entry = this.latestSessionMessage((message) => message?.role === "toolResult" && message.toolCallId === callId);
    if (!entry) return;
    item.tool.resultImages = sessionContentImages(entry);
    if (!(item.tool.name === "bash" && item.tool.terminalVisible)) this.stream(turboStream("replace", ids.item(this.ctx, item.key), renderTranscriptItem(this.ctx, item, { live: true, open: true })));
  }

  private async handleEvent(event: any): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this.liveEnsure();
        this.setBusy(true);
        break;
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (!inner) break;
        const stopReason = inner.partial?.stopReason ?? inner.reason;
        if (isFinalAssistantStopReason(stopReason)) this.liveFinalStart();
        if (inner.type === "text_delta") this.liveTextDelta(inner.delta ?? "");
        else if (inner.type === "thinking_delta") this.liveThinkingDelta(inner.delta ?? "");
        else if (inner.type === "toolcall_start") {
          const part = inner.partial?.content?.[inner.contentIndex];
          this.liveToolStreamStart(part?.name ?? "tool");
        } else if (inner.type === "toolcall_delta") this.liveToolArgsDelta(inner.delta ?? "");
        else if (inner.type === "toolcall_end" && inner.toolCall) {
          if (!isJsonObject(inner.toolCall.arguments)) throw new TypeError(`tool ${inner.toolCall.name} arguments must be a JSON object`);
          this.liveToolCallComplete({ callId: inner.toolCall.id, name: inner.toolCall.name, args: inner.toolCall.arguments });
        }
        break;
      }
      case "tool_execution_start": {
        if (!isJsonObject(event.args)) throw new TypeError(`tool ${event.toolName} arguments must be a JSON object`);
        this.liveToolExecStart({ callId: event.toolCallId, name: event.toolName, args: event.args });
        break;
      }
      case "tool_execution_update": {
        const details = isToolViewDetails(event.partialResult?.details) ? event.partialResult.details : undefined;
        const text = contentText(event.partialResult?.content ?? []);
        this.liveToolUpdate(event.toolCallId, { tmuxSession: details?.tmuxSession, outputText: text || undefined, details });
        break;
      }
      case "tool_execution_end": {
        const text = contentText(event.result?.content ?? []);
        const details = isToolViewDetails(event.result?.details) ? event.result.details : undefined;
        this.liveToolEnd(event.toolCallId, text, Boolean(event.isError), details);
        break;
      }
      case "message_end": {
        const message = event.message;
        // Pi notifies subscribers just before it appends a completed message to
        // the session. Resolve display URLs on the next task, once that session
        // entry is available as the image's single source of truth.
        if (message?.role === "user") setTimeout(() => this.syncLiveUserEntry(), 0);
        if (message?.role === "toolResult") setTimeout(() => this.syncLiveToolResult(message.toolCallId), 0);
        if (message?.role === "assistant") {
          const text = contentText(message.content);
          if (isFinalAssistantMessage(message.content, message.stopReason)) {
            this.liveFinal(text);
          } else {
            this.closeOpenItem();
          }
          if (message.stopReason !== "aborted" && message.stopReason !== "error") {
            const miss = detectCacheMiss(this.session.sessionManager.getBranch(), message, this.session.modelRuntime);
            if (miss) this.liveCacheMiss(miss);
          }
          void this.refreshStats();
        }
        break;
      }
      case "agent_end":
        await this.liveEnd();
        this.setBusy(false);
        await this.emitTurnFinished();
        break;
      case "compaction_start":
        this.setBusy(true);
        this.notice("info", event.reason === "manual" ? "Compacting context…" : "Auto-compacting context…");
        break;
      case "compaction_end": {
        const entry = event.result && this.latestCompactionEntry();
        if (entry) this.postCompactionEstimate = { entryId: entry.id, tokens: event.result.estimatedTokensAfter };
        await this.refreshTranscript();
        await this.refreshStats();
        this.notice(
          event.errorMessage ? "error" : "info",
          event.errorMessage ?? (event.aborted ? "Compaction cancelled" : "Context compacted"),
        );
        if (!event.willRetry) this.setBusy(false);
        if (event.reason === "manual") await this.emitTurnFinished();
        break;
      }
      case "auto_retry_start":
        this.notice("info", `Provider error, retrying (attempt ${event.attempt}/${event.maxAttempts})…`);
        break;
      default:
        break;
    }
  }

  async submit(text: string, options: SubmitOptions): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && (options.images?.length ?? 0) === 0) return;
    const noteLines = options.attachmentNotes ?? [];
    const fullText = noteLines.length > 0 ? `${trimmed}\n\n${noteLines.join("\n")}` : trimmed;
    const images = (options.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));

    if (this.session.isStreaming) {
      await this.session.steer(fullText, images.length > 0 ? images : undefined);
      this.liveNote(`Steer: ${trimmed}`, "system");
      return;
    }

    this.liveBegin({ text: trimmed, images: [] });
    this.setBusy(true);
    void this.session
      .prompt(fullText, images.length > 0 ? { images } : undefined)
      // Pi extensions can reject with arbitrary JavaScript values. This final
      // boundary renders the reason safely, then restores agent lifecycle state.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The rejection is normalized here.
      .catch(async (error: unknown) => {
        this.notice("error", error instanceof Error ? error.message : String(error));
        await this.liveEnd();
        this.setBusy(false);
        await this.emitTurnFinished();
      });
  }

  async compact(customInstructions?: string): Promise<void> {
    try {
      await this.session.compact(customInstructions?.trim() || undefined);
    } catch {
      // Pi reports compaction failures through compaction_end; handleEvent renders
      // that error in the agent pane, so the command response must remain successful.
    }
  }

  async abort(): Promise<void> {
    if (this.session.isCompacting) {
      this.session.abortCompaction();
      return;
    }
    if (this.summarizing) {
      this.session.abortBranchSummary?.();
      return;
    }
    await this.session.abort();
    await this.liveEnd();
    this.setBusy(false);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model not available: ${provider}/${modelId}`);
    await this.session.setModel(model);
    this.ctx.model = this.currentModel();
    const remembered = await getModelThinkingLevel(provider, modelId);
    if (remembered && this.availableThinkingLevels().includes(remembered)) this.session.setThinkingLevel(remembered);
    await this.refreshStats();
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.session.setThinkingLevel(level);
    await this.refreshStats();
  }

  async setServiceTier(serviceTier: AgentServiceTier): Promise<void> {
    const provider = this.currentModel()?.provider;
    if (!provider || !supportsFastMode(provider)) return;
    await this.serviceTiers.set(provider, serviceTier);
    await this.refreshStats();
  }

  async newSession(): Promise<void> {
    if (this.isStreaming) throw new Error("Stop the agent before starting a new session.");
    const model = this.session.model;
    const thinkingLevel = this.session.thinkingLevel;
    const serviceTier = await this.currentServiceTier();
    const agent = await replaceWorkspaceAgentSession({ workspaceId: this.workspaceId, conversationId: this.conversationId, label: this.label, title: this.title, path: this.sessionFile });
    const created = await createPiSession(agent, this.options, { model, thinkingLevel, serviceTier });
    this.unsubscribeSession?.();
    this.session = created.session;
    this.toolsForModel = created.toolViews;
    this.serviceTiers = created.serviceTiers;
    this.sessionFile = agent.path;
    this.subscribeToSession();
    this.stream((await this.snapshotStream()).html);
  }

  treeHtml(options: { filter: TreeFilterMode; query: string }): string {
    return renderAgentSessionTree(this.session.sessionManager, options);
  }

  labelTreeEntry(entryId: string, label: string, operation: "add" | "remove"): void {
    updateAgentSessionTreeLabel(this.session.sessionManager, entryId, label, operation);
  }

  async navigateTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string> {
    if (this.isStreaming) throw new Error("Stop the agent before navigating the session tree.");
    if (options.summarize) {
      this.summarizing = true;
      this.setBusy(true);
    }
    try {
      const result = await this.session.navigateTree(entryId, {
        summarize: options.summarize,
        customInstructions: options.customInstructions?.trim() || undefined,
      });
      this.serviceTiers.reload();
      await this.refreshTranscript();
      await this.refreshStats();
      return result.editorText ?? "";
    } finally {
      if (options.summarize) {
        this.summarizing = false;
        this.setBusy(false);
      }
    }
  }

  async rewind(entryId: string, mode: RewindMode, customInstructions?: string): Promise<void> {
    if (this.session.isStreaming) throw new Error("Stop the agent before rewinding.");
    const entry = this.session.sessionManager.getEntry(entryId);
    if (!entry) throw new Error("Rewind target no longer exists.");
    const target = entry.parentId;
    if (!target) throw new Error("Cannot rewind past the first message.");
    if (mode === "summary") {
      // Show the truncated transcript immediately and treat the summarizer like
      // any other busy agent: a live transcript item with a stop button.
      this.summarizing = true;
      this.liveBegin();
      this.liveNote("Summarizing the abandoned branch…", "system");
      const truncated = await this.canonicalItems(target);
      if (this.live) truncated.push(...this.liveItemsForDisplay(this.live));
      this.stream(turboStream("update", ids.transcript(this.ctx), renderTranscript(this.ctx, truncated, this.modelContext())));
      void this.session
        .navigateTree(target, { summarize: true, customInstructions: customInstructions?.trim() || undefined })
        // The summarizer may reject with any JavaScript value. This detached task
        // owns that boundary: catch renders the reason and finally performs cleanup.
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The rejection is normalized here.
        .catch((error: unknown) => this.notice("error", error instanceof Error ? error.message : String(error)))
        .finally(async () => {
          this.summarizing = false;
          await this.liveEnd();
        });
      return;
    }
    await this.session.navigateTree(target, { summarize: false });
    this.serviceTiers.reload();
    await this.refreshTranscript();
    await this.refreshStats();
  }
}

async function loadWorkspaceAgentsFiles(workspaceId: string): Promise<Array<{ path: string; content: string }>> {
  const agentsPaths = [`${workspaceRoot}/AGENTS.md`, `${workspaceRoot}/.atelier/AGENTS.md`];
  const agentsFiles: Array<{ path: string; content: string }> = [];

  for (const path of agentsPaths) {
    const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", `if test -s ${shellQuote(path)}; then cat ${shellQuote(path)}; fi`], { workdir: workspaceRoot });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not read ${path}`);
    if (result.stdout.trim()) agentsFiles.push({ path, content: result.stdout });
  }

  return agentsFiles;
}

const bootstrapOnlySessionEntryTypes = new Set(["model_change", "thinking_level_change"]);
const sessionEntryTypeSchema = Type.Object({ type: Type.String() });

export async function discardBootstrapOnlySession(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return;
  const entries = lines.map((line) => Value.Parse(sessionEntryTypeSchema, JSON.parse(line)));
  if (entries.every((entry) => bootstrapOnlySessionEntryTypes.has(entry.type))) await writeFile(path, "");
}

async function createPiSession(agent: WorkspaceAgentConversationInfo, options: WorkspaceAgentRuntimeOptions, initial: InitialSessionSettings = {}): Promise<{ session: any; toolViews: AgentToolDefinitionView[]; serviceTiers: AgentServiceTierState }> {
  await ensureSessionFile(agent.path);
  await discardBootstrapOnlySession(agent.path);
  const [modelRuntime, defaultModel] = await Promise.all([
    createPiModelRuntime(),
    preferredNewWorkspaceAgentModel(),
  ]);
  const [agentsFiles, skillResources] = await Promise.all([
    loadWorkspaceAgentsFiles(agent.workspaceId),
    loadWorkspaceSkills(agent.workspaceId),
  ]);
  const appendSystemPrompt: string[] = [];
  await options.events?.emit("agent_system_prompt_prepare", { workspaceId: agent.workspaceId, lines: appendSystemPrompt });
  let sessionSettings;
  if (defaultModel) {
    sessionSettings = {
      defaultProvider: defaultModel.provider,
      defaultModel: defaultModel.id,
      compaction: { enabled: true, keepRecentTokens: compactionKeepRecentTokens },
    };
  } else {
    sessionSettings = { compaction: { enabled: true, keepRecentTokens: compactionKeepRecentTokens } };
  }
  const sessionManager = SessionManager.open(agent.path, dirname(agent.path), workspaceRoot);
  const serviceTiers = new AgentServiceTierState(sessionManager);
  const customTools = createWorkspaceAgentTools(agent.workspaceId, { events: options.events });
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    agentDir: dirname(agent.path),
    modelRuntime: modelRuntimeWithServiceTiers(modelRuntime, serviceTiers),
    model: initial.model,
    thinkingLevel: initial.thinkingLevel,
    resourceLoader: createAtelierResourceLoader(agentsFiles, appendSystemPrompt, skillResources),
    customTools,
    tools: workspaceAgentToolNames(),
    sessionManager,
    settingsManager: SettingsManager.inMemory(sessionSettings),
  });
  const provider = session.model?.provider;
  if (provider && initial.serviceTier && supportsFastMode(provider)) await serviceTiers.set(provider, initial.serviceTier);
  return {
    session,
    serviceTiers,
    toolViews: customTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  };
}

async function createRealRuntime(agent: WorkspaceAgentConversationInfo, options: WorkspaceAgentRuntimeOptions = {}): Promise<WorkspaceAgentRuntime> {
  const created = await createPiSession(agent, options);
  return new RealAgentRuntime(agent, created.session, created.toolViews, created.serviceTiers, options);
}

async function ensureSessionFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a");
  await file.close();
}
