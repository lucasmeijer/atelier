import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { AtelierEventBus } from "@atelier/core";
import { execWorkspaceCommand, workspaceRoot } from "@atelier/workspace";
import { createPiAuthStorage, getConfiguredAgentModels, getModelThinkingLevel, piModelsJsonPath } from "./pi-config-models.ts";
import {
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { turboAppendText, turboStream } from "./html.ts";
import {
  ids,
  renderFinalText,
  renderItem,
  renderNotice,
  renderPendingFollowups,
  renderPromptActions,
  renderRunningToolCard,
  renderSection,
  renderStatsBar,
  renderStreamingThinkingItem,
  renderStreamingToolItem,
  renderToolCard,
  renderTranscript,
  type AgentPaneState,
  type AgentRenderContext,
  type AgentStatsView,
} from "./render.ts";
import type { WorkspaceAgentInfo } from "./session-store.ts";
import { atelierSystemPrompt, createAtelierResourceLoader } from "./system-prompt.ts";
import { createWorkspaceAgentTools, workspaceAgentToolNames } from "./tools.ts";
import {
  buildSections,
  toolDetailsIndicateError,
  type ImageRef,
  type SectionView,
  type ToolView,
  type TranscriptRecord,
} from "./transcript.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

type AgentSubscriber = (streamHtml: string) => void;
type WorkspaceTabBusyListener = (event: { workspaceId: string; tabKey: string; busy: boolean }) => void;

const workspaceTabBusyListeners = new Set<WorkspaceTabBusyListener>();

export function subscribeWorkspaceTabBusy(listener: WorkspaceTabBusyListener): () => void {
  workspaceTabBusyListeners.add(listener);
  return () => workspaceTabBusyListeners.delete(listener);
}

export type SubmitMode = "send" | "steer" | "followup";

interface SubmitOptions {
  mode: SubmitMode;
  images?: ImageRef[];
  /** Extra lines appended to the prompt describing non-image attachments. */
  attachmentNotes?: string[];
}

export type RewindMode = "discard" | "summary" | "custom";

interface WorkspaceAgentRuntime {
  workspaceId: string;
  label: string;
  sessionFile: string;
  readonly isStreaming: boolean;
  subscribe(listener: AgentSubscriber): () => void;
  /** Turbo-stream HTML bringing a fresh client fully up to date. */
  snapshotStream(): Promise<string>;
  /** Server-rendered state for initial pane HTML. */
  paneState(): Promise<AgentPaneState>;
  systemPrompt(): string;
  userMessages(): string[];
  submit(text: string, options: SubmitOptions): Promise<void>;
  cancelFollowup(id: string): Promise<void>;
  abort(): Promise<void>;
  currentModel(): { provider: string; id: string } | undefined;
  availableThinkingLevels(): string[];
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  rewind(entryId: string, mode: RewindMode, note?: string): Promise<void>;
}

const runtimes = new Map<string, Promise<WorkspaceAgentRuntime>>();

function runtimeKey(workspaceId: string, label: string): string {
  return `${workspaceId}\u0000${label}`;
}

interface WorkspaceAgentRuntimeOptions {
  events?: AtelierEventBus;
}

export function getWorkspaceAgentRuntime(agent: WorkspaceAgentInfo, options: WorkspaceAgentRuntimeOptions = {}): Promise<WorkspaceAgentRuntime> {
  const key = runtimeKey(agent.workspaceId, agent.label);
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRealRuntime(agent, options);
    runtimes.set(key, runtime);
  }
  return runtime;
}

// ---------------------------------------------------------------------------
// Base runtime: subscriber fanout, delta batching, live-section streaming.
// ---------------------------------------------------------------------------

const deltaFlushMs = 25;
const streamingSyntaxHighlightMs = 250;

interface LiveState {
  view: SectionView;
  /** Currently open streaming item, deltas append to it. */
  open?: { index: number; kind: "text" | "thinking" | "toolargs" };
  toolIndexByCallId: Map<string, number>;
  /** Timers that reveal a tool's live terminal after a delay. */
  terminalTimers: Map<string, ReturnType<typeof setTimeout>>;
}

interface StreamingMarkdownState {
  renderTimer?: ReturnType<typeof setTimeout>;
  highlightTimer?: ReturnType<typeof setTimeout>;
  lastHighlightAt: number;
  getText: () => string;
}

interface PendingFollowup {
  id: string;
  displayText: string;
  fullText: string;
  imageRefs: ImageRef[];
  imageContent?: { type: "image"; data: string; mimeType: string }[];
}

/** Only attach the inline terminal when a tool call has been running this long. */
const terminalRevealMs = 3000;

abstract class BaseAgentRuntime implements WorkspaceAgentRuntime {
  workspaceId: string;
  label: string;
  sessionFile: string;
  protected ctx: AgentRenderContext;
  protected live?: LiveState;
  private busy = false;
  private subscribers = new Set<AgentSubscriber>();
  private pendingDeltas = new Map<string, string>();
  private deltaTimer: ReturnType<typeof setTimeout> | undefined;
  private streamingMarkdown = new Map<string, StreamingMarkdownState>();
  private pendingFollowups: PendingFollowup[] = [];

  constructor(agent: WorkspaceAgentInfo, protected readonly options: WorkspaceAgentRuntimeOptions = {}) {
    this.workspaceId = agent.workspaceId;
    this.label = agent.label;
    this.sessionFile = agent.path;
    this.ctx = { workspaceId: agent.workspaceId, label: agent.label };
  }

  protected async emitTurnFinished(): Promise<void> {
    await this.options.events?.emit("workspace_agent_turn_finished", { workspaceId: this.workspaceId, agentLabel: this.label });
  }

  get isStreaming(): boolean {
    return this.busy;
  }

  subscribe(listener: AgentSubscriber): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  protected broadcastRaw(streamHtml: string): void {
    for (const subscriber of this.subscribers) subscriber(streamHtml);
  }

  /** Structural op: flushes pending text deltas first to preserve ordering. */
  protected stream(html: string): void {
    this.flushDeltas();
    this.broadcastRaw(html);
  }

  protected delta(target: string, text: string): void {
    if (!text) return;
    this.pendingDeltas.set(target, (this.pendingDeltas.get(target) ?? "") + text);
    if (!this.deltaTimer) {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), deltaFlushMs);
    }
  }

  protected flushDeltas(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = undefined;
    }
    if (this.pendingDeltas.size === 0) return;
    let payload = "";
    for (const [target, text] of this.pendingDeltas) payload += turboAppendText(target, text);
    this.pendingDeltas.clear();
    this.broadcastRaw(payload);
  }

  private scheduleStreamingMarkdown(target: string, getText: () => string): void {
    let state = this.streamingMarkdown.get(target);
    if (!state) {
      state = { lastHighlightAt: Date.now(), getText };
      this.streamingMarkdown.set(target, state);
    }
    state.getText = getText;
    if (!state.renderTimer) {
      state.renderTimer = setTimeout(() => this.renderStreamingMarkdown(target, false), deltaFlushMs);
    }
  }

  private renderStreamingMarkdown(target: string, forceHighlight: boolean): void {
    const state = this.streamingMarkdown.get(target);
    if (!state) return;
    if (state.renderTimer) {
      clearTimeout(state.renderTimer);
      state.renderTimer = undefined;
    }
    const now = Date.now();
    const shouldHighlight = forceHighlight || now - state.lastHighlightAt >= streamingSyntaxHighlightMs;
    if (shouldHighlight) state.lastHighlightAt = now;
    this.broadcastRaw(turboStream("update", target, renderFinalText(this.ctx, state.getText(), { highlightCode: shouldHighlight })));
    if (!shouldHighlight && !state.highlightTimer) {
      const delay = Math.max(0, streamingSyntaxHighlightMs - (now - state.lastHighlightAt));
      state.highlightTimer = setTimeout(() => {
        const current = this.streamingMarkdown.get(target);
        if (current) current.highlightTimer = undefined;
        this.renderStreamingMarkdown(target, true);
      }, delay);
    }
  }

  private flushStreamingMarkdown(target?: string, options: { highlightCode?: boolean; remove?: boolean } = {}): void {
    const targets = target ? [target] : [...this.streamingMarkdown.keys()];
    for (const key of targets) {
      const state = this.streamingMarkdown.get(key);
      if (!state) continue;
      if (state.renderTimer) clearTimeout(state.renderTimer);
      if (state.highlightTimer) clearTimeout(state.highlightTimer);
      state.renderTimer = undefined;
      state.highlightTimer = undefined;
      if (!options.remove) {
        this.broadcastRaw(turboStream("update", key, renderFinalText(this.ctx, state.getText(), { highlightCode: options.highlightCode ?? true })));
      }
      this.streamingMarkdown.delete(key);
    }
  }

  protected setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    for (const listener of workspaceTabBusyListeners) listener({ workspaceId: this.workspaceId, tabKey: `agent:${this.label}`, busy });
    this.stream(turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, busy)));
  }

  protected notice(level: "info" | "error", message: string): void {
    this.stream(turboStream("append", ids.notices(this.ctx), renderNotice(level, message)));
  }

  protected queuePendingFollowup(item: Omit<PendingFollowup, "id">): string {
    const id = crypto.randomUUID();
    this.pendingFollowups.push({ id, ...item });
    this.renderPendingFollowups();
    return id;
  }

  protected shiftPendingFollowup(): PendingFollowup | undefined {
    const next = this.pendingFollowups.shift();
    if (next) this.renderPendingFollowups();
    return next;
  }

  async cancelFollowup(id: string): Promise<void> {
    const index = this.pendingFollowups.findIndex((item) => item.id === id);
    if (index === -1) return;
    this.pendingFollowups.splice(index, 1);
    this.renderPendingFollowups();
  }

  private renderPendingFollowups(): void {
    this.stream(turboStream("update", ids.pendingFollowups(this.ctx), renderPendingFollowups(this.ctx, this.pendingFollowups)));
  }

  // ---- live section streaming -------------------------------------------

  protected liveBegin(user?: { text: string; images: ImageRef[] }): void {
    if (this.live) return;
    const view: SectionView = {
      sid: `live_${Date.now().toString(36)}`,
      startedAt: Date.now(),
      user,
      items: [],
      stats: { tools: 0, durationMs: 0, outTokens: 0, cost: 0 },
      streaming: true,
    };
    this.live = { view, toolIndexByCallId: new Map(), terminalTimers: new Map() };
    this.stream(turboStream("append", ids.transcript(this.ctx), renderSection(this.ctx, view)));
  }

  protected liveEnsure(): LiveState {
    if (!this.live) this.liveBegin();
    return this.live!;
  }

  private appendItemHtml(html: string): void {
    this.stream(turboStream("append", ids.activityBody(this.ctx, this.live!.view.sid), html));
  }

  private liveFinalTarget(live: LiveState): string {
    return ids.final(this.ctx, live.view.sid);
  }

  private promoteOpenTextToActivity(): void {
    const live = this.live;
    if (!live?.open || live.open.kind !== "text") return;
    const index = live.open.index;
    this.flushStreamingMarkdown(this.liveFinalTarget(live), { remove: true });
    const item = live.view.items[index];
    if (item?.type === "text") this.appendItemHtml(renderItem(this.ctx, live.view.sid, index, item));
    this.stream(turboStream("update", this.liveFinalTarget(live), ""));
    live.open = undefined;
  }

  protected closeOpenItem(): void {
    this.promoteOpenTextToActivity();
    const live = this.live;
    if (live) live.open = undefined;
  }

  protected liveTextDelta(text: string): void {
    const live = this.liveEnsure();
    if (!live.open || live.open.kind !== "text") {
      const index = live.view.items.length;
      live.view.items.push({ type: "text", text: "", stopReason: "toolUse" });
      live.open = { index, kind: "text" };
    }
    const item = live.view.items[live.open.index];
    if (item.type === "text") item.text += text;
    const target = this.liveFinalTarget(live);
    this.scheduleStreamingMarkdown(target, () => item.type === "text" ? item.text : "");
  }

  protected liveThinkingDelta(text: string): void {
    const live = this.liveEnsure();
    if (live.open?.kind === "text") this.promoteOpenTextToActivity();
    if (!live.open || live.open.kind !== "thinking") {
      const index = live.view.items.length;
      live.view.items.push({ type: "thinking", text: "" });
      live.open = { index, kind: "thinking" };
      this.appendItemHtml(renderStreamingThinkingItem(this.ctx, live.view.sid, index));
    }
    const item = live.view.items[live.open.index];
    if (item.type === "thinking") item.text += text;
    this.delta(ids.itemText(this.ctx, live.view.sid, live.open.index), text);
  }

  protected liveToolStreamStart(name: string): number {
    const live = this.liveEnsure();
    if (live.open?.kind === "text") this.promoteOpenTextToActivity();
    const index = live.view.items.length;
    const tool: ToolView = { callId: `pending_${index}`, name, args: undefined, status: "streaming", argsStream: "" };
    live.view.items.push({ type: "tool", tool });
    live.open = { index, kind: "toolargs" };
    this.appendItemHtml(renderStreamingToolItem(this.ctx, live.view.sid, index, name));
    return index;
  }

  protected liveToolArgsDelta(text: string): void {
    const live = this.live;
    if (!live || live.open?.kind !== "toolargs") return;
    const item = live.view.items[live.open.index];
    if (item.type === "tool") item.tool.argsStream = (item.tool.argsStream ?? "") + text;
    this.delta(ids.itemText(this.ctx, live.view.sid, live.open.index), text);
  }

  /** Tool call arguments fully parsed (execution may not have started yet). */
  protected liveToolCallComplete(callId: string, name: string, args: unknown): void {
    const live = this.liveEnsure();
    let index: number;
    if (live.open?.kind === "toolargs") {
      index = live.open.index;
      live.open = undefined;
    } else {
      index = live.view.items.length;
      live.view.items.push({ type: "tool", tool: { callId, name, args, status: "running" } });
      this.appendItemHtml(`<div class="agent-item" id="${ids.item(this.ctx, live.view.sid, index)}"></div>`);
    }
    const item = live.view.items[index];
    if (item?.type !== "tool") return;
    item.tool.callId = callId;
    item.tool.name = name;
    item.tool.args = args;
    item.tool.status = "running";
    item.tool.argsStream = undefined;
    item.tool.startedAt = Date.now();
    if (name === "bash") {
      const timeout = (args as { timeout?: number } | undefined)?.timeout;
      item.tool.timeoutSeconds = typeof timeout === "number" && timeout > 0 ? timeout : 600;
    }
    live.toolIndexByCallId.set(callId, index);
    this.stream(turboStream("update", ids.item(this.ctx, live.view.sid, index), renderRunningToolCard(this.ctx, item.tool)));
  }

  protected liveToolExecStart(callId: string, name: string, args: unknown): void {
    const live = this.liveEnsure();
    if (!live.toolIndexByCallId.has(callId)) this.liveToolCallComplete(callId, name, args);
  }

  protected liveToolUpdate(callId: string, update: { tmuxSession?: string; outputText?: string; details?: unknown }): void {
    const live = this.live;
    if (!live) return;
    const index = live.toolIndexByCallId.get(callId);
    if (index === undefined) return;
    const item = live.view.items[index];
    if (item?.type !== "tool") return;
    if (update.tmuxSession && !item.tool.tmuxSession) {
      item.tool.tmuxSession = update.tmuxSession;
      // Reveal the inline terminal only if the command is still running after a delay.
      const timer = setTimeout(() => {
        const current = this.live;
        if (!current || current !== live) return;
        const revisit = current.view.items[index];
        if (revisit?.type !== "tool" || revisit.tool.status !== "running") return;
        revisit.tool.terminalVisible = true;
        this.stream(turboStream("update", ids.item(this.ctx, current.view.sid, index), renderRunningToolCard(this.ctx, revisit.tool)));
      }, terminalRevealMs);
      live.terminalTimers.set(callId, timer);
    }
    if (update.outputText !== undefined) item.tool.resultText = update.outputText;
    if (update.details !== undefined) item.tool.details = update.details;
    this.stream(turboStream("update", ids.item(this.ctx, live.view.sid, index), renderRunningToolCard(this.ctx, item.tool)));
  }

  protected liveToolEnd(callId: string, resultText: string, isError: boolean, details?: unknown): void {
    const live = this.live;
    if (!live) return;
    const timer = live.terminalTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      live.terminalTimers.delete(callId);
    }
    const index = live.toolIndexByCallId.get(callId);
    if (index === undefined) return;
    const item = live.view.items[index];
    if (item?.type !== "tool") return;
    item.tool.status = isError || toolDetailsIndicateError(details) ? "error" : "ok";
    item.tool.resultText = resultText;
    item.tool.details = details;
    item.tool.tmuxSession = undefined;
    live.view.stats.tools += 1;
    this.stream(turboStream("update", ids.item(this.ctx, live.view.sid, index), renderToolCard(this.ctx, item.tool, { open: true })));
  }

  protected liveNote(text: string, tone: "system" | "summary" | "error"): void {
    const live = this.liveEnsure();
    this.closeOpenItem();
    const index = live.view.items.length;
    live.view.items.push({ type: "note", text, tone });
    this.appendItemHtml(renderItem(this.ctx, live.view.sid, index, live.view.items[index]));
  }

  protected liveUsage(outTokens: number, cost: number): void {
    const live = this.live;
    if (!live) return;
    live.view.stats.outTokens += outTokens;
    live.view.stats.cost += cost;
  }

  /** The final assistant message arrived: move trailing text item into the final slot. */
  protected liveFinal(text: string): void {
    const live = this.live;
    if (!live) return;
    if (live.open?.kind === "text") {
      const index = live.open.index;
      this.flushStreamingMarkdown(this.liveFinalTarget(live), { remove: true });
      live.view.items.splice(index, 1);
      live.open = undefined;
    }
    live.view.finalText = text;
    this.stream(turboStream("update", ids.final(this.ctx, live.view.sid), renderFinalText(this.ctx, text)));
  }

  /** Run ended: replace everything with the canonical transcript. */
  protected async liveEnd(): Promise<void> {
    this.flushStreamingMarkdown(undefined, { remove: true });
    if (this.live) for (const timer of this.live.terminalTimers.values()) clearTimeout(timer);
    this.live = undefined;
    await this.refreshTranscript();
    await this.refreshStats();
  }

  /**
   * Canonical sections plus the live section. The persisted store usually
   * already contains the in-progress run's user message, so a trailing
   * canonical section matching the live section's user message is dropped.
   */
  private async sectionsForDisplay(): Promise<SectionView[]> {
    const sections = await this.canonicalSections();
    const live = this.live;
    if (live) {
      const last = sections[sections.length - 1];
      if (last && live.view.user !== undefined && last.user?.text === live.view.user.text) sections.pop();
      sections.push(live.view);
    }
    return sections;
  }

  protected async refreshTranscript(): Promise<void> {
    this.stream(turboStream("update", ids.transcript(this.ctx), renderTranscript(this.ctx, await this.sectionsForDisplay(), this.systemPrompt())));
  }

  protected async refreshStats(): Promise<void> {
    this.stream(turboStream("update", ids.stats(this.ctx), renderStatsBar(this.ctx, await this.statsView())));
  }

  async snapshotStream(): Promise<string> {
    const state = await this.paneState();
    return (
      turboStream("update", ids.transcript(this.ctx), state.transcriptHtml) +
      turboStream("update", ids.pendingFollowups(this.ctx), state.pendingFollowupsHtml ?? "") +
      turboStream("update", ids.actions(this.ctx), renderPromptActions(this.ctx, state.busy)) +
      turboStream("update", ids.stats(this.ctx), renderStatsBar(this.ctx, state.stats))
    );
  }

  async paneState(): Promise<AgentPaneState> {
    return {
      transcriptHtml: renderTranscript(this.ctx, await this.sectionsForDisplay(), this.systemPrompt()),
      pendingFollowupsHtml: renderPendingFollowups(this.ctx, this.pendingFollowups),
      busy: this.busy,
      stats: await this.statsView(),
    };
  }

  abstract systemPrompt(): string;
  abstract userMessages(): string[];
  protected abstract canonicalSections(): Promise<SectionView[]>;
  protected abstract statsView(): Promise<AgentStatsView>;
  abstract submit(text: string, options: SubmitOptions): Promise<void>;
  abstract abort(): Promise<void>;
  abstract currentModel(): { provider: string; id: string } | undefined;
  abstract availableThinkingLevels(): string[];
  abstract setModel(provider: string, modelId: string): Promise<void>;
  abstract setThinkingLevel(level: string): Promise<void>;
  abstract rewind(entryId: string, mode: RewindMode, note?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real runtime (pi agent SDK)
// ---------------------------------------------------------------------------

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && (part as { type?: string }).type === "text")
    .map((part) => part.text)
    .join("\n");
}

function contentImages(content: unknown): ImageRef[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is { type: "image"; data: string; mimeType: string } => Boolean(part) && (part as { type?: string }).type === "image")
    .map((part) => ({ mimeType: part.mimeType, data: part.data }));
}

function entryTimestamp(entry: { timestamp?: string }, message?: { timestamp?: number }): number {
  if (typeof message?.timestamp === "number") {
    // pi stores seconds or ms depending on producer; normalize to ms.
    return message.timestamp > 10_000_000_000 ? message.timestamp : message.timestamp * 1000;
  }
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function recordsFromSessionEntries(entries: any[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;
      if (!message) continue;
      if (message.role === "user") {
        records.push({ kind: "user", id: entry.id, text: contentToText(message.content), images: contentImages(message.content), timestamp: entryTimestamp(entry, message), rewindable: entry.parentId !== null && entry.parentId !== undefined });
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
          outTokens: message.usage?.output ?? 0,
          cost: message.usage?.cost?.total ?? 0,
          timestamp: entryTimestamp(entry, message),
        });
      } else if (message.role === "toolResult") {
        records.push({ kind: "toolResult", callId: message.toolCallId, text: contentToText(message.content), isError: Boolean(message.isError), timestamp: entryTimestamp(entry, message), details: message.details });
      } else if (message.role === "bashExecution") {
        records.push({ kind: "note", id: entry.id, text: `\`$ ${message.command}\`\n\n\`\`\`\n${message.output ?? ""}\n\`\`\``, tone: "system", timestamp: entryTimestamp(entry, message) });
      } else if (message.role === "custom" && message.display) {
        records.push({ kind: "note", id: entry.id, text: contentToText(message.content), tone: "summary", timestamp: entryTimestamp(entry, message) });
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
      records.push({ kind: "note", id: entry.id, text: contentToText(entry.content), tone: "summary", timestamp: entryTimestamp(entry) });
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

  constructor(agent: WorkspaceAgentInfo, private session: any, options: WorkspaceAgentRuntimeOptions = {}) {
    super(agent, options);
    session.subscribe((event: any) => {
      void this.handleEvent(event);
    });
  }

  private async configuredModelOptions(): Promise<{ provider: string; id: string; name: string; model: any; available: boolean }[]> {
    // Configured model picker list, resolved against the registry at render time.
    const configuredModels = await getConfiguredAgentModels();
    const available = new Set((this.session.modelRegistry.getAvailable?.() as Array<{ provider: string; id: string }> | undefined ?? []).map((model) => `${model.provider}::${model.id}`));
    return configuredModels.map((configured) => ({
      provider: configured.provider,
      id: configured.id,
      name: configured.label,
      model: this.session.modelRegistry.find?.(configured.provider, configured.id),
      available: available.has(`${configured.provider}::${configured.id}`),
    }));
  }

  systemPrompt(): string {
    return this.session.systemPrompt ?? "";
  }

  currentModel(): { provider: string; id: string } | undefined {
    const model = this.session.model;
    return model?.provider && model?.id ? { provider: model.provider, id: model.id } : undefined;
  }

  availableThinkingLevels(): string[] {
    return this.session.supportsThinking?.() ? this.session.getAvailableThinkingLevels() : [];
  }

  userMessages(): string[] {
    try {
      return recordsFromSessionEntries(this.session.sessionManager.getBranch())
        .filter((record) => record.kind === "user")
        .map((record) => (record as { text: string }).text);
    } catch {
      return [];
    }
  }

  protected async canonicalSections(leafId?: string): Promise<SectionView[]> {
    const entries = this.session.sessionManager.getBranch(leafId);
    return buildSections(recordsFromSessionEntries(entries));
  }

  protected async statsView(): Promise<AgentStatsView> {
    const stats = this.session.getSessionStats?.();
    const context = this.session.getContextUsage?.();
    const model = this.session.model;
    const models = (await this.configuredModelOptions()).map((option) => ({
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
      contextPercent: context?.percent ?? null,
      inputTokens: stats?.tokens?.input ?? 0,
      outputTokens: stats?.tokens?.output ?? 0,
      cost: stats?.cost ?? 0,
      modelName: model?.name ?? model?.id,
      provider: model?.provider,
      thinkingLevel: this.session.thinkingLevel ?? "off",
      thinkingLevels: this.availableThinkingLevels(),
      models,
    };
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
        if (inner.type === "text_delta") this.liveTextDelta(inner.delta ?? "");
        else if (inner.type === "thinking_delta") this.liveThinkingDelta(inner.delta ?? "");
        else if (inner.type === "toolcall_start") {
          const part = inner.partial?.content?.[inner.contentIndex];
          this.liveToolStreamStart(part?.name ?? "tool");
        } else if (inner.type === "toolcall_delta") this.liveToolArgsDelta(inner.delta ?? "");
        else if (inner.type === "toolcall_end" && inner.toolCall) {
          this.liveToolCallComplete(inner.toolCall.id, inner.toolCall.name, inner.toolCall.arguments);
        }
        break;
      }
      case "tool_execution_start":
        this.liveToolExecStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update": {
        const details = event.partialResult?.details;
        const text = contentToText(event.partialResult?.content);
        this.liveToolUpdate(event.toolCallId, { tmuxSession: details?.tmuxSession, outputText: text || undefined, details });
        break;
      }
      case "tool_execution_end": {
        const text = contentToText(event.result?.content);
        this.liveToolEnd(event.toolCallId, text, Boolean(event.isError), event.result?.details);
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message?.role === "assistant") {
          this.liveUsage(message.usage?.output ?? 0, message.usage?.cost?.total ?? 0);
          const text = contentToText(message.content);
          const hasToolCalls = Array.isArray(message.content) && message.content.some((part: any) => part?.type === "toolCall");
          if (text && !hasToolCalls && message.stopReason !== "aborted" && message.stopReason !== "error") {
            this.liveFinal(text);
          } else {
            this.closeOpenItem();
          }
          void this.refreshStats();
        }
        break;
      }
      case "agent_end":
        await this.liveEnd();
        this.setBusy(false);
        await this.emitTurnFinished();
        this.startNextPendingFollowup();
        break;
      case "compaction_start":
        this.notice("info", "Compacting context…");
        break;
      case "compaction_end":
        this.notice("info", event.aborted ? "Compaction cancelled" : "Context compacted");
        await this.refreshTranscript();
        break;
      case "auto_retry_start":
        this.notice("info", `Provider error, retrying (attempt ${event.attempt}/${event.maxAttempts})…`);
        break;
      default:
        break;
    }
  }

  private refreshModelRegistryForCurrentModel(): void {
    const current = this.session.model;
    this.session.modelRegistry.authStorage?.reload?.();
    this.session.modelRegistry.refresh?.();
    if (!current?.provider || !current?.id) return;
    const refreshed = this.session.modelRegistry.find?.(current.provider, current.id);
    if (refreshed) this.session.agent.state.model = refreshed;
  }

  async submit(text: string, options: SubmitOptions): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && (options.images?.length ?? 0) === 0) return;
    const noteLines = options.attachmentNotes ?? [];
    const fullText = noteLines.length > 0 ? `${trimmed}\n\n${noteLines.join("\n")}` : trimmed;
    const images = (options.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));

    if (this.session.isStreaming) {
      if (options.mode === "followup") {
        this.queuePendingFollowup({ displayText: trimmed || "(attachments)", fullText, imageRefs: options.images ?? [], imageContent: images.length > 0 ? images : undefined });
      } else {
        await this.session.steer(fullText, images.length > 0 ? images : undefined);
        this.liveNote(`Steer: ${trimmed}`, "system");
      }
      return;
    }

    this.refreshModelRegistryForCurrentModel();
    this.liveBegin({ text: trimmed, images: options.images ?? [] });
    this.setBusy(true);
    void this.session
      .prompt(fullText, images.length > 0 ? { images } : undefined)
      .catch(async (error: unknown) => {
        this.notice("error", error instanceof Error ? error.message : String(error));
        await this.liveEnd();
        this.setBusy(false);
        await this.emitTurnFinished();
      });
  }

  private startNextPendingFollowup(): void {
    const next = this.shiftPendingFollowup();
    if (!next) return;
    this.liveBegin({ text: next.displayText === "(attachments)" ? "" : next.displayText, images: next.imageRefs });
    this.setBusy(true);
    void (async () => {
      this.refreshModelRegistryForCurrentModel();
      await this.session.prompt(next.fullText, next.imageContent && next.imageContent.length > 0 ? { images: next.imageContent } : undefined);
    })().catch(async (error: unknown) => {
      this.notice("error", error instanceof Error ? error.message : String(error));
      await this.liveEnd();
      this.setBusy(false);
      await this.emitTurnFinished();
    });
  }

  async abort(): Promise<void> {
    if (this.summarizing) {
      this.session.abortBranchSummary?.();
      return;
    }
    await this.session.abort();
    await this.liveEnd();
    this.setBusy(false);
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.session.modelRegistry.authStorage?.reload?.();
    this.session.modelRegistry.refresh?.();
    const model = this.session.modelRegistry.find?.(provider, modelId);
    if (!model) {
      this.notice("error", `Model not available: ${provider}/${modelId}`);
      return;
    }
    try {
      await this.session.setModel(model);
      const remembered = await getModelThinkingLevel(provider, modelId);
      if (remembered && this.availableThinkingLevels().includes(remembered)) this.session.setThinkingLevel(remembered);
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error));
    }
    await this.refreshStats();
  }

  async setThinkingLevel(level: string): Promise<void> {
    try {
      this.session.setThinkingLevel(level);
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error));
    }
    await this.refreshStats();
  }

  async rewind(entryId: string, mode: RewindMode, note?: string): Promise<void> {
    if (this.session.isStreaming) {
      this.notice("error", "Stop the agent before rewinding.");
      return;
    }
    const entry = this.session.sessionManager.getEntry(entryId);
    if (!entry) {
      this.notice("error", "Rewind target no longer exists.");
      return;
    }
    const target = entry.parentId;
    if (!target) {
      this.notice("error", "Cannot rewind past the first message.");
      return;
    }
    if (mode === "summary") {
      // Show the truncated transcript immediately and treat the summarizer like
      // any other busy agent: a streaming pseudo-section with a stop button.
      this.summarizing = true;
      this.liveBegin();
      this.liveNote("Summarizing the abandoned branch…", "system");
      const truncated = await this.canonicalSections(target);
      if (this.live) truncated.push(this.live.view);
      this.stream(turboStream("update", ids.transcript(this.ctx), renderTranscript(this.ctx, truncated, this.systemPrompt())));
      void this.session
        .navigateTree(target, { summarize: true })
        .catch((error: unknown) => this.notice("error", error instanceof Error ? error.message : String(error)))
        .finally(async () => {
          this.summarizing = false;
          await this.liveEnd();
        });
      return;
    }
    try {
      await this.session.navigateTree(target, { summarize: false });
      if (mode === "custom" && note?.trim()) {
        await this.session.sendCustomMessage(
          { customType: "atelier-branch-note", content: `Note about an abandoned attempt that was rewound: ${note.trim()}`, display: true, details: undefined },
          { triggerTurn: false },
        );
      }
    } catch (error) {
      this.notice("error", error instanceof Error ? error.message : String(error));
    }
    await this.refreshTranscript();
    await this.refreshStats();
  }
}

async function loadWorkspaceAgentsFiles(workspaceId: string): Promise<Array<{ path: string; content: string }>> {
  const agentsPath = `${workspaceRoot}/AGENTS.md`;
  try {
    const result = await execWorkspaceCommand(workspaceId, ["cat", agentsPath], { workdir: workspaceRoot });
    if (result.exitCode === 0 && result.stdout.trim()) return [{ path: agentsPath, content: result.stdout }];
  } catch {
    // AGENTS.md context is best-effort; workspace startup should not fail if it cannot be read.
  }
  return [];
}

async function createRealRuntime(agent: WorkspaceAgentInfo, options: WorkspaceAgentRuntimeOptions = {}): Promise<WorkspaceAgentRuntime> {
  await ensureSessionFile(agent.path);
  const authStorage = await createPiAuthStorage();
  const modelRegistry = ModelRegistry.create(authStorage, await piModelsJsonPath());
  const agentsFiles = await loadWorkspaceAgentsFiles(agent.workspaceId);
  const sessionManager = SessionManager.open(agent.path, dirname(agent.path), workspaceRoot);
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    agentDir: dirname(agent.path),
    authStorage,
    modelRegistry,
    resourceLoader: createAtelierResourceLoader(agentsFiles),
    customTools: createWorkspaceAgentTools(agent.workspaceId, { events: options.events }),
    tools: workspaceAgentToolNames(),
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } } as any),
  });
  return new RealAgentRuntime(agent, session, options);
}

async function ensureSessionFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a");
  await file.close();
}
