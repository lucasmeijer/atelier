import { parseSubagentDelivery, queuedModelDelivery, subagentDeliveryType } from "./subagent-delivery.ts";
import { subagentSnapshot, subscribeSubagentChanges, steerSubagents } from "./subagents.ts";
import { agentPath } from "./subagent-protocol.ts";
import { isJsonObject } from "@atelier/core";
import { contentText } from "@earendil-works/pi-ai";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { BaseAgentRuntime } from "./base-agent-runtime.ts";
import { collectCacheMisses, detectCacheMiss } from "./cache-miss.ts";
import { turboStream } from "./html.ts";
import { isFinalAssistantTextEvent } from "./live-presentation.ts";
import { createPiSession } from "./pi-session.ts";
import { configuredModelOptionViews } from "./model-state.ts";
import { getModelThinkingLevel } from "./pi-config-models.ts";
import type { AgentStatsView } from "./render-composer.ts";
import { ids } from "./render-context.ts";
import {
  renderTranscript,
  renderTranscriptItem,
  type AgentModelContextView,
  type AgentToolDefinitionView,
} from "./render-transcript.ts";
import { contextUsagePercent, manualCompactionAvailable, terminalCompactionNotice } from "./runtime-status.ts";
import type { RewindMode, SubmitOptions, WorkspaceAgentRuntime, WorkspaceAgentRuntimeOptions } from "./runtime-types.ts";
import { AgentServiceTierState, supportsFastMode, type AgentServiceTier } from "./service-tier.ts";
import { recordsFromSessionEntries, sessionContentImages } from "./session-records.ts";
import { replaceWorkspaceAgentSession, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import { renderAgentSessionTree, updateAgentSessionTreeLabel, type TreeFilterMode } from "./session-tree.ts";
import {
  buildTranscript,
  finalAssistantText,
  isFinalAssistantMessage,
  isToolViewDetails,
  type SessionImageRef,
  type TranscriptItem,
} from "./transcript.ts";

import { TurnTiming, turnTimingEntryType } from "./turn-timing.ts";

interface AgentPromptPreflightOptions {
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  preflightResult(success: boolean): void;
}

// Promise rejections from Pi extensions and background presentation work are
// external JavaScript values. Normalize them once at that boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the normalization boundary.
function normalizedPromiseError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class RealAgentRuntime extends BaseAgentRuntime {
  // Present from agent_start through agent_end, including mid-loop compaction.
  private turnTiming?: TurnTiming;
  private summarizing = false;
  private unsubscribeSession?: () => void;
  private postCompactionEstimate?: { entryId: string; tokens: number };
  private pendingAcceptedPrompt?: { text: string; images: SessionImageRef[] };
  private readonly terminalSessionOperations = new Set<Promise<void>>();
  private disposal?: Promise<void>;
  private unsubscribeSubagents: () => void;
  private lastModelDeliveryId?: string;
  private readonly communicationVersions = new Map<string, string>();

  constructor(agent: WorkspaceAgentConversationInfo, private session: any, private toolsForModel: AgentToolDefinitionView[], private serviceTiers: AgentServiceTierState, options: WorkspaceAgentRuntimeOptions = {}) {
    super(agent, options);
    this.ctx.model = this.currentModel();
    this.subscribeToSession();
    for (const item of this.communicationItems()) this.communicationVersions.set(item.key, JSON.stringify(item.communication));
    this.lastModelDeliveryId = this.session.sessionManager.getBranch().findLast((entry: any) => entry.type === "custom" && entry.customType === subagentDeliveryType)?.id;
    this.unsubscribeSubagents = subscribeSubagentChanges((workspaceId) => {
      if (workspaceId !== this.workspaceId) return;
      const latest = this.session.sessionManager.getBranch().findLast((entry: any) => entry.type === "custom" && entry.customType === subagentDeliveryType);
      if (latest?.id !== this.lastModelDeliveryId) {
        this.lastModelDeliveryId = latest?.id;
        if (latest && this.live) {
          const batch = queuedModelDelivery(parseSubagentDelivery(latest.data));
          if (batch?.duringActivity) this.liveNote("", "summary", { key: latest.id, modelDelivery: batch });
          else if (batch) this.stream(turboStream("before", ids.item(this.ctx, this.live.working.key), renderTranscriptItem(this.ctx, { type: "note", key: latest.id, text: "", tone: "summary", modelDelivery: batch })));
        } else void this.refreshTranscript();
      }
      for (const item of this.communicationItems()) {
        const previous = this.communicationVersions.get(item.key);
        const version = JSON.stringify(item.communication);
        if (previous === version) continue;
        this.communicationVersions.set(item.key, version);
        this.stream(turboStream(previous ? "replace" : "append", previous ? ids.item(this.ctx, item.key) : ids.transcript(this.ctx), renderTranscriptItem(this.ctx, item)));
      }
    });
  }

  private communicationItems(): Extract<TranscriptItem, { type: "note" }>[] {
    const state = subagentSnapshot(this.workspaceId);
    const own = state.agents.find((agent) => agent.id === this.conversationId);
    const branch = this.session.sessionManager.getBranch();
    const immediate = new Map<string, { envelope: string; format: "agent_message" | "user" }>();
    for (const entry of branch.filter((entry: any) => entry.type === "custom" && entry.customType === subagentDeliveryType)) {
      const batch = parseSubagentDelivery(entry.data);
      for (const message of batch.messages) if (message.immediate) immediate.set(message.id, { envelope: message.envelope, format: batch.format ?? "agent_message" });
    }
    const inheritedIds = new Set(branch.filter((entry: any) => entry.type === "custom_message" && entry.customType === "subagent").map((entry: any) => entry.details?.subagentMessageId));
    return state.messages.filter((message) => (message.to === this.conversationId || inheritedIds.has(message.id)) && ["task", "message", "completion"].includes(message.kind)).map((message) => ({
      type: "note", key: `communication:${message.id}`, text: message.text, tone: "summary",
      timestamp: Date.parse(message.timestamp),
      communication: { id: message.id, rootId: own?.rootId ?? this.conversationId, agentId: message.from, path: agentPath(state, message.from), kind: message.kind, delivery: message.delivery, dispatchMode: message.dispatchMode, dispatchReason: message.dispatchReason, deliveredEnvelope: immediate.get(message.id)?.envelope, deliveredFormat: immediate.get(message.id)?.format },
    }));
  }

  protected override decorateTranscript(items: TranscriptItem[]): TranscriptItem[] {
    const state = subagentSnapshot(this.workspaceId);
    const messages = this.communicationItems();
    const markOutgoing = (items: TranscriptItem[]): void => {
      for (const item of items) {
        if (item.type === "working") markOutgoing(item.items);
        if (item.type === "tool") item.communicationId = state.messages.find((message) => message.from === this.conversationId && message.toolCallId === item.tool.callId)?.id;
        if (item.type === "text" && item.final) item.communicationId = state.messages.find((message) => message.from === this.conversationId && message.kind === "completion" && Date.parse(message.timestamp) >= (item.timestamp ?? 0) && (message.text === item.text || message.text === `[completed] ${item.text}`))?.id;
      }
    };
    markOutgoing(items);
    const result = [...items, ...messages].sort((a, b) => (a.timestamp ?? (a.type === "working" ? a.startedAt : 0)) - (b.timestamp ?? (b.type === "working" ? b.startedAt : 0)));
    const branch = this.session.sessionManager.getBranch();
    const latestTurn = branch.findLast((entry: any) => (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "subagent" && entry.details?.kind === "task"));
    for (const entry of branch.filter((entry: any) => entry.type === "custom" && entry.customType === subagentDeliveryType)) {
      const batch = queuedModelDelivery(parseSubagentDelivery(entry.data));
      if (!batch) continue;
      const item: TranscriptItem = { type: "note", key: entry.id, timestamp: Date.parse(entry.timestamp), text: "", tone: "summary", modelDelivery: batch };
      const working = result.find((item) => item.type === "working" && (item.key === `${batch.turnEntryId}:working` || (item.live && batch.turnEntryId === latestTurn?.id)));
      if (working?.type === "working" && batch.duringActivity) {
        if (working.items.some((existing) => existing.key === item.key)) continue;
        working.items = [...working.items, item].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      } else if (working) result.splice(result.indexOf(working), 0, item);
      else {
        const next = result.findIndex((candidate) => (candidate.timestamp ?? 0) > item.timestamp!);
        result.splice(next < 0 ? result.length : next, 0, item);
      }
    }
    return result;
  }

  private subscribeToSession(): void {
    this.unsubscribeSession = this.session.subscribe((event: any) => {
      void this.handleEvent(event);
    });
  }

  private trackTerminalSessionOperation<Result>(operation: Promise<Result>): Promise<Result> {
    const terminal = operation.then(() => undefined, () => undefined);
    this.terminalSessionOperations.add(terminal);
    void terminal.then(() => {
      this.terminalSessionOperations.delete(terminal);
    });
    return operation;
  }

  private async awaitTerminalSessionOperations(): Promise<void> {
    while (this.terminalSessionOperations.size > 0) {
      await Promise.all(this.terminalSessionOperations);
    }
  }

  override get isStreaming(): boolean {
    return Boolean(this.session.isStreaming || this.summarizing);
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
    this.assertActive();
    return recordsFromSessionEntries(this.session.sessionManager.getBranch())
      .filter((record) => record.kind === "user")
      .map((record) => record.text);
  }

  protected canonicalItems(leafId?: string): TranscriptItem[] {
    const entries = this.session.sessionManager.getBranch(leafId);
    const cacheMisses = collectCacheMisses(entries, this.session.modelRuntime);
    return buildTranscript(recordsFromSessionEntries(entries, cacheMisses));
  }

  private latestCompactionEntry(): CompactionEntry | undefined {
    return this.session.sessionManager.getBranch().findLast((entry: any) => entry.type === "compaction");
  }

  protected async statsView(): Promise<AgentStatsView> {
    const stats = this.session.getSessionStats?.();
    const context = this.session.getContextUsage?.();
    const model = this.session.model;
    const estimate = this.postCompactionEstimate;
    const branch = this.session.sessionManager.getBranch();
    const latestCompactionEntryId = branch.findLast((entry: any) => entry.type === "compaction")?.id;
    const thinkingLevel = this.currentThinkingLevel();
    const thinkingLevels = this.availableThinkingLevels();
    const estimatedTokens = latestCompactionEntryId === estimate?.entryId ? estimate?.tokens : undefined;
    const contextPercent = contextUsagePercent(context?.percent, estimatedTokens, model?.contextWindow);
    const models = await configuredModelOptionViews(model ?? null, this.session.modelRuntime);
    // Current model outside the configured list: show it as a selected extra entry.
    if (model && !models.some((option) => option.selected)) {
      // Show the current session model for accuracy, but do not offer it as a
      // selectable choice unless it is also in the user's configured models list.
      models.unshift({ provider: model.provider, id: model.id, name: model.name ?? model.id, selected: true, available: false, unavailableReason: "Model is not configured" });
    }
    return {
      contextPercent,
      compactAvailable: manualCompactionAvailable(context?.tokens, branch.at(-1)?.type),
      inputTokens: stats?.tokens?.input ?? 0,
      outputTokens: stats?.tokens?.output ?? 0,
      cost: stats?.cost ?? 0,
      modelName: model?.name ?? model?.id,
      thinkingLevel,
      thinkingLevels,
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
    this.streamActiveToolContent(item);
  }

  private async handleEvent(event: any): Promise<void> {
    switch (event.type) {
      case "agent_start":
        this.turnTiming = new TurnTiming(performance.now());
        this.liveBegin(this.pendingAcceptedPrompt);
        this.pendingAcceptedPrompt = undefined;
        this.setBusy(true);
        break;
      case "turn_start":
        this.turnTiming?.inferenceStart(performance.now());
        break;
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (!inner) break;
        if (inner.type === "text_start") this.liveTextStart(inner.contentIndex, isFinalAssistantTextEvent(inner));
        else if (inner.type === "text_delta") this.liveTextDelta(inner.delta ?? "", inner.contentIndex, isFinalAssistantTextEvent(inner));
        else if (inner.type === "text_end") this.liveTextEnd(inner.contentIndex);
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
        this.turnTiming?.toolStart(event.toolCallId, performance.now());
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
        this.turnTiming?.toolEnd(event.toolCallId, performance.now());
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
          this.turnTiming?.inferenceEnd(performance.now(), message.usage?.output);
          if (isFinalAssistantMessage(message.content, message.stopReason)) {
            this.liveFinal(finalAssistantText(message.content));
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
        if (this.turnTiming) {
          const timing = this.turnTiming.snapshot(performance.now());
          this.session.sessionManager.appendCustomEntry(turnTimingEntryType, timing);
          if (this.live) this.live.working.timing = timing;
          this.turnTiming = undefined;
        }
        // End state and readiness are one synchronous lifecycle boundary. Stats
        // are secondary presentation data and cannot delay, suppress, or race a
        // newer agent_start into being marked idle.
        this.finishLivePresentation();
        if (!event.willRetry) {
          this.setBusy(false);
          await this.emitTurnFinished();
        }
        void this.refreshStats().catch((error) => {
          console.error("Could not refresh Agent stats after turn completion", normalizedPromiseError(error));
        });
        break;
      case "compaction_start":
        this.setBusy(true);
        this.notice("info", event.reason === "manual" ? "Compacting context…" : "Auto-compacting context…");
        break;
      case "compaction_end": {
        const entry = event.result && this.latestCompactionEntry();
        if (entry) this.postCompactionEstimate = { entryId: entry.id, tokens: event.result.estimatedTokensAfter };
        // Mid-loop threshold compaction has willRetry=false, but inference
        // continues without another agent_start. Only clear busy outside a loop.
        if (!event.willRetry && !this.turnTiming) this.setBusy(false);
        if (event.reason === "manual" && !event.willRetry) await this.emitTurnFinished();
        await this.refreshTranscript();
        await this.refreshStats();
        const notice = terminalCompactionNotice(event);
        if (notice) this.notice(notice.level, notice.message);
        break;
      }
      case "auto_retry_start":
        this.notice("info", `Provider error, retrying (attempt ${event.attempt}/${event.maxAttempts})…`);
        break;
      default:
        break;
    }
  }

  async submit(text: string, options: SubmitOptions = {}): Promise<void> {
    this.assertActive();
    const trimmed = text.trim();
    const noteLines = options.attachmentNotes ?? [];
    const fullText = noteLines.length > 0 ? `${trimmed}\n\n${noteLines.join("\n")}` : trimmed;
    const images = (options.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }));
    if (!fullText.trim() && images.length === 0) return;
    if (this.summarizing) throw new Error("Wait for branch summarization to finish before sending another prompt.");

    if (this.session.isStreaming) {
      await this.session.steer(fullText, images.length > 0 ? images : undefined);
      steerSubagents(this.workspaceId, this.conversationId);
      this.liveNote(`Steer: ${trimmed}`, "system");
      return;
    }

    let accepted = false;
    let acceptedPrompt: { text: string; images: SessionImageRef[] } | undefined;
    const { promise: acceptance, resolve: resolveAcceptance, reject: rejectAcceptance } = Promise.withResolvers<void>();
    const thisRuntime = this;
    const promptOptions: AgentPromptPreflightOptions = {
      preflightResult(success) {
        if (!success) return;
        accepted = true;
        // Pi invokes this immediately before starting the agent loop. Keep the
        // accepted prompt pending until agent_start so immediately handled
        // extension commands never create a speculative user/Working section or
        // leave the Agent busy without a matching agent_end.
        acceptedPrompt = { text: trimmed, images: [] };
        thisRuntime.pendingAcceptedPrompt = acceptedPrompt;
        resolveAcceptance();
      },
    };
    if (images.length > 0) promptOptions.images = images;
    void this.session
      .prompt(fullText, promptOptions)
      .then(() => {
        // An accepted extension/input handler may complete without starting an
        // agent loop. Its direct mutations are authoritative, while the pending
        // prompt was never presented and must not keep lifecycle state alive.
        if (thisRuntime.pendingAcceptedPrompt === acceptedPrompt) {
          thisRuntime.pendingAcceptedPrompt = undefined;
          void thisRuntime.streamRendered(async () => await thisRuntime.authoritativePresentationUpdate()).catch((error) => {
            console.error("Could not refresh Agent after handled prompt", normalizedPromiseError(error));
          });
        }
      })
      // Pi extensions can reject with arbitrary JavaScript values. Before
      // acceptance the original value is propagated to the route; after
      // acceptance Pi's event stream owns the terminal lifecycle.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- normalizedPromiseError owns this external boundary.
      .catch((error: unknown) => {
        if (!accepted) {
          if (this.pendingAcceptedPrompt === acceptedPrompt) this.pendingAcceptedPrompt = undefined;
          rejectAcceptance(normalizedPromiseError(error));
          return;
        }
        // Accepted agent runs report failures and terminal lifecycle through Pi's
        // event stream. Rendering a second terminal path here would duplicate
        // readiness and can race a newer run.
        console.error("Accepted Agent prompt failed outside its event lifecycle", normalizedPromiseError(error));
      });
    await acceptance;
  }

  private async compactSession(customInstructions?: string): Promise<void> {
    try {
      await this.session.compact(customInstructions?.trim() || undefined);
    } catch {
      // Pi reports compaction failures through compaction_end; handleEvent renders
      // that error in the agent pane, so the command response must remain successful.
    }
  }

  async compact(customInstructions?: string): Promise<void> {
    this.assertActive();
    await this.trackTerminalSessionOperation(this.compactSession(customInstructions));
  }

  async abort(): Promise<void> {
    if (this.summarizing) {
      this.session.abortBranchSummary?.();
    } else if (this.session.isCompacting) {
      this.session.abortCompaction();
      await this.session.waitForIdle();
    } else {
      await this.session.abort();
    }
    await this.awaitTerminalSessionOperations();
    this.finishLivePresentation();
    this.setBusy(false);
    void this.refreshStats().catch((error) => {
      console.error("Could not refresh Agent stats after abort", normalizedPromiseError(error));
    });
  }

  private async finishDisposal(): Promise<void> {
    this.unsubscribeSubagents();
    const unsubscribe = this.unsubscribeSession;
    this.unsubscribeSession = undefined;
    unsubscribe?.();
    try {
      await this.abort();
    } finally {
      this.setBusy(false);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (!this.markDisposed()) return Promise.resolve();
    this.disposal = this.finishDisposal();
    return this.disposal;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.assertActive();
    const model = this.session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Model not available: ${provider}/${modelId}`);
    await this.session.setModel(model);
    this.ctx.model = this.currentModel();
    const remembered = await getModelThinkingLevel(provider, modelId);
    if (remembered && this.availableThinkingLevels().includes(remembered)) this.session.setThinkingLevel(remembered);
    await this.refreshStats();
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.assertActive();
    this.session.setThinkingLevel(level);
    await this.refreshStats();
  }

  async setServiceTier(serviceTier: AgentServiceTier): Promise<void> {
    this.assertActive();
    const provider = this.currentModel()?.provider;
    if (!provider || !supportsFastMode(provider)) return;
    await this.serviceTiers.set(provider, serviceTier);
    await this.refreshStats();
  }

  async newSession(): Promise<void> {
    this.assertActive();
    if (this.isStreaming) throw new Error("Stop the agent before starting a new session.");
    const model = this.session.model;
    const thinkingLevel = this.session.thinkingLevel;
    const serviceTier = await this.currentServiceTier();
    const agent = await replaceWorkspaceAgentSession({ workspaceId: this.workspaceId, conversationId: this.conversationId, label: this.label, title: this.title, path: this.sessionFile });
    const created = await createPiSession(agent, this.options, { model, thinkingLevel, serviceTier });
    try {
      this.assertActive();
    } catch (error) {
      await created.session.abort();
      throw error;
    }
    this.unsubscribeSession?.();
    this.session = created.session;
    this.toolsForModel = created.toolViews;
    this.serviceTiers = created.serviceTiers;
    this.sessionFile = agent.path;
    this.subscribeToSession();
    await this.streamRendered(async () => await this.authoritativePresentationUpdate());
  }

  treeHtml(options: { filter: TreeFilterMode; query: string }): string {
    this.assertActive();
    return renderAgentSessionTree(this.session.sessionManager, options);
  }

  labelTreeEntry(entryId: string, label: string, operation: "add" | "remove"): void {
    this.assertActive();
    updateAgentSessionTreeLabel(this.session.sessionManager, entryId, label, operation);
  }

  private async navigateSessionTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string> {
    if (options.summarize) this.beginBranchSummary();
    try {
      const result = await this.session.navigateTree(entryId, {
        summarize: options.summarize,
        customInstructions: options.customInstructions?.trim() || undefined,
      });
      this.serviceTiers.reload();
      if (options.summarize) {
        await this.finishBranchSummary();
        void (async () => {
          await this.refreshTranscript();
          await this.refreshStats();
        })().catch((error) => {
          console.error("Could not refresh Agent after tree summarization", normalizedPromiseError(error));
        });
        return result.editorText ?? "";
      }
      await this.refreshTranscript();
      await this.refreshStats();
      return result.editorText ?? "";
    } finally {
      if (options.summarize) await this.finishBranchSummary();
    }
  }

  async navigateTree(entryId: string, options: { summarize: boolean; customInstructions?: string }): Promise<string> {
    this.assertActive();
    if (this.isStreaming) throw new Error("Stop the agent before navigating the session tree.");
    return await this.trackTerminalSessionOperation(this.navigateSessionTree(entryId, options));
  }

  private startDetachedRewindSummary(target: string, customInstructions?: string): Promise<void> {
    let started = false;
    const { promise: startedOperation, resolve: resolveStarted, reject: rejectStarted } = Promise.withResolvers<void>();
    const lifecycle = (async () => {
      this.beginBranchSummary();
      try {
        this.liveBegin();
        this.liveNote("Summarizing the abandoned branch…", "system");
        await this.streamRendered(async () => {
          const truncated = this.canonicalItems(target);
          if (this.live) truncated.push(...this.liveItemsForDisplay(this.live));
          return turboStream("update", ids.transcript(this.ctx), renderTranscript(this.ctx, truncated, this.modelContext()));
        });
        this.assertActive();
        const navigation = this.session.navigateTree(target, { summarize: true, customInstructions: customInstructions?.trim() || undefined });
        started = true;
        resolveStarted();
        await navigation;
      // The summarizer may reject with any JavaScript value. Before the
      // detached operation starts, reject the route; afterward render the error.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- normalizedPromiseError owns this external boundary.
      } catch (error: unknown) {
        const normalized = normalizedPromiseError(error);
        if (!started) rejectStarted(normalized);
        else this.notice("error", normalized.message);
      } finally {
        try {
          this.serviceTiers.reload();
        } finally {
          this.finishLivePresentation();
          await this.finishBranchSummary();
        }
        void (async () => {
          await this.refreshTranscript();
          await this.refreshStats();
        })().catch((error) => {
          console.error("Could not refresh Agent after rewind summarization", normalizedPromiseError(error));
        });
      }
    })();
    this.trackTerminalSessionOperation(lifecycle);
    return startedOperation;
  }

  async rewind(entryId: string, mode: RewindMode, customInstructions?: string): Promise<void> {
    this.assertActive();
    if (this.isStreaming) throw new Error("Stop the agent before rewinding.");
    const entry = this.session.sessionManager.getEntry(entryId);
    if (!entry) throw new Error("Rewind target no longer exists.");
    const target = entry.parentId;
    if (!target) throw new Error("Cannot rewind past the first message.");
    if (mode === "summary") {
      // Return once Pi owns the summarization, while retaining its terminal
      // lifecycle so abort/dispose can join it before the session is archived.
      await this.startDetachedRewindSummary(target, customInstructions);
      return;
    }
    await this.trackTerminalSessionOperation((async () => {
      await this.session.navigateTree(target, { summarize: false });
      this.serviceTiers.reload();
      await this.refreshTranscript();
      await this.refreshStats();
    })());
  }

  private beginBranchSummary(): void {
    this.summarizing = true;
    this.setBusy(true);
  }

  private async finishBranchSummary(): Promise<void> {
    if (!this.summarizing) return;
    this.summarizing = false;
    this.setBusy(false);
    await this.emitTurnFinished();
  }
}


export async function createRealRuntime(agent: WorkspaceAgentConversationInfo, options: WorkspaceAgentRuntimeOptions = {}): Promise<WorkspaceAgentRuntime> {
  const created = await createPiSession(agent, options);
  return new RealAgentRuntime(agent, created.session, created.toolViews, created.serviceTiers, options);
}
