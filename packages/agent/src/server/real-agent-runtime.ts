import { applyTranscriptContributions } from "./transcript-contributions.ts";
import { isJsonObject } from "@atelier/core";
import { contentText, type UserMessage } from "@earendil-works/pi-ai";
import type { CompactionEntry } from "@earendil-works/pi-coding-agent";
import { BaseAgentRuntime } from "./base-agent-runtime.ts";
import { collectCacheMisses, detectCacheMiss } from "./cache-miss.ts";
import { turboStream } from "./html.ts";
import { isFinalAssistantTextEvent } from "./live-presentation.ts";
import { createPiSession, type AgentSessionDelegation } from "./pi-session.ts";
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
  assistantErrorText,
  finalAssistantTextIndexes,
  buildTranscript,
  finalAssistantText,
  isFinalAssistantMessage,
  isToolViewDetails,
  type SessionImageRef,
  type TranscriptItem,
} from "./transcript.ts";

import { TurnTiming, turnStartEntryType, turnTimingEntryType } from "./turn-timing.ts";

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
  // Present until Pi settles the entire prompt, including retries and overflow recovery.
  private turnTiming?: TurnTiming;
  private turnEntryId?: string;
  private runStartedAt = 0;
  private pendingAssistantError?: string;
  private terminalOutcome: "completed" | "stopped" = "completed";
  private readonly pendingSteering: string[] = [];
  private summarizing = false;
  private unsubscribeSession?: () => void;
  private postCompactionEstimate?: { entryId: string; tokens: number };
  private pendingAcceptedPrompt?: symbol;
  private readonly terminalSessionOperations = new Set<Promise<void>>();
  private disposal?: Promise<void>;
  private unsubscribeTranscript?: () => void;

  constructor(agent: WorkspaceAgentConversationInfo, private session: any, private toolsForModel: AgentToolDefinitionView[], private serviceTiers: AgentServiceTierState, options: WorkspaceAgentRuntimeOptions = {}, private delegation: AgentSessionDelegation = { dispose: async () => {} }) {
    super(agent, options);
    this.ctx.model = this.currentModel();
    this.selectBranch();
    try {
      this.subscribeToSession();
      this.attachTranscript();
    } catch (error) {
      this.unsubscribeSession?.();
      this.detachTranscript();
      throw error;
    }
  }

  private attachTranscript(): void {
    this.captureContributedRows();
    this.unsubscribeTranscript = this.delegation.transcript?.subscribe(() => this.refreshContributedRows());
  }

  private detachTranscript(): void {
    const unsubscribe = this.unsubscribeTranscript;
    this.unsubscribeTranscript = undefined;
    unsubscribe?.();
  }

  protected override liveTiming() {
    return this.turnTiming?.snapshot(performance.now()) ?? super.liveTiming();
  }

  protected override decorateTranscript(items: TranscriptItem[]): TranscriptItem[] {
    const snapshot = this.delegation.transcript?.snapshot();
    if (!snapshot) return items;
    return applyTranscriptContributions(items, snapshot);
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

  private selectBranch(): void {
    for (const key of this.pendingSteering) this.liveConsumePendingUser(key);
    this.pendingSteering.length = 0;
    this.resetTurnSubscriptions(`${this.session.sessionManager.getSessionId()}:${this.session.sessionManager.getLeafId() ?? "root"}`);
  }

  private finishRun(outcome: "completed" | "stopped"): void {
    if (this.turnTiming) {
      const timing = this.turnTiming.snapshot(performance.now());
      this.session.sessionManager.appendCustomEntry(turnTimingEntryType, { ...timing, turnEntryId: this.turnEntryId, outcome });
      if (this.live) this.live.working.timing = timing;
      this.turnTiming = undefined;
    }
    this.finishLivePresentation(outcome);
    this.turnEntryId = undefined;
  }

  private beginPersistedRun(entryId: string, user?: { text: string; images: SessionImageRef[] }): void {
    if (this.live) {
      this.live.working.inputEntryIds!.push(entryId);
      return;
    }
    this.turnEntryId = entryId;
    this.session.sessionManager.appendCustomEntry(turnStartEntryType, { turnEntryId: entryId, startedAt: this.runStartedAt });
    this.liveBegin(user, entryId, this.runStartedAt);
  }

  private consumePersistedUser(message: UserMessage): void {
    const entry = this.latestSessionMessage((persisted) => persisted === message);
    if (!entry) throw new Error("Consumed user message was not persisted by Pi");
    const text = contentText(entry.message.content);
    // Pi may expand prompt templates before consuming queued steering. Queue
    // order, rather than text equality, links its user to the pending display.
    const pending = this.pendingSteering.shift();
    const user = { text, images: sessionContentImages(entry) };
    if (this.live) this.liveSteeringUser(entry.id, user, pending);
    else {
      if (pending) this.liveConsumePendingUser(pending);
      this.beginPersistedRun(entry.id, user);
    }
    this.pendingAcceptedPrompt = undefined;
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
        if (this.live && this.pendingAssistantError) {
          this.liveInnerError(this.pendingAssistantError);
          this.pendingAssistantError = undefined;
        }
        if (!this.turnTiming) {
          this.runStartedAt = Date.now();
          this.turnTiming = new TurnTiming(performance.now());
          this.terminalOutcome = "completed";
        }
        if (!this.live && !this.pendingAcceptedPrompt) {
          const records = recordsFromSessionEntries(this.session.sessionManager.getBranch());
          const startIndex = records.findLastIndex((record) => record.kind === "user" || record.kind === "taskStart");
          const start = records[startIndex];
          const finished = records.slice(startIndex + 1).some((record) => record.kind === "timing");
          // A newly triggered task is persisted after agent_start. Do not
          // re-advertise the previous completed block while waiting for it.
          if (start && (start.kind === "user" || start.kind === "taskStart") && !finished) this.beginPersistedRun(start.id);
        }
        this.setBusy(true);
        break;
      case "turn_start":
        this.turnTiming?.inferenceStart(performance.now());
        break;
      case "message_start":
        if (event.message?.role === "assistant") {
          this.liveAssistantMessageStart();
        }
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
        // Pi appends synchronously after listener dispatch. The microtask sees
        // its permanent entry ID before the next assistant event is dispatched.
        if (message?.role === "user") {
          await Promise.resolve();
          this.consumePersistedUser(message);
        }
        if (message?.role === "custom") {
          await Promise.resolve();
          const start = recordsFromSessionEntries(this.session.sessionManager.getBranch()).at(-1);
          if (start?.kind === "taskStart" && this.turnTiming) this.beginPersistedRun(start.id);
        }
        if (message?.role === "toolResult") setTimeout(() => this.syncLiveToolResult(message.toolCallId), 0);
        if (message?.role === "assistant") {
          this.turnTiming?.inferenceEnd(performance.now(), message.usage?.output);
          if (message.stopReason !== "aborted" && message.stopReason !== "error") this.terminalOutcome = "completed";
          if (isFinalAssistantMessage(message.content, message.stopReason)) {
            this.liveFinal(finalAssistantText(message.content), finalAssistantTextIndexes(message.content));
          } else {
            if (message.stopReason === "error" || message.stopReason === "aborted") this.liveAssistantFailure();
            else this.closeOpenItem();
            // Classify the completed message once; Pi's continuation or settled
            // event determines whether its error belongs inside or outside.
            const errorText = assistantErrorText(message);
            if (errorText) {
              this.pendingAssistantError = errorText;
              this.terminalOutcome = "stopped";
            }
          }
          if (message.stopReason !== "aborted" && message.stopReason !== "error") {
            const miss = detectCacheMiss(this.session.sessionManager.getBranch(), message, this.session.modelRuntime);
            if (miss) this.liveCacheMiss(miss);
          }
        }
        break;
      }
      case "agent_settled":
        // agent_end only ends an agent-core loop. Pi may still compact and
        // continue without another user, even when agent_end.willRetry is false.
        if (!this.turnTiming) break;
        if (this.pendingAssistantError) {
          this.liveNote(this.pendingAssistantError, "error");
          this.pendingAssistantError = undefined;
        }
        this.finishRun(this.terminalOutcome);
        this.setBusy(false);
        await this.emitTurnFinished();
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
        // Compaction may happen between loops or mid-loop. Keep the whole
        // prompt busy until agent_settled, independent of willRetry.
        if (!event.willRetry && !this.turnTiming) this.setBusy(false);
        if (event.reason === "manual" && !event.willRetry) await this.emitTurnFinished();
        await this.refreshTranscript();
        await this.refreshStats();
        const notice = terminalCompactionNotice(event);
        if (notice) this.notice(notice.level, notice.message);
        break;
      }
      case "auto_retry_end":
        if (!event.success && this.turnTiming) {
          if (event.finalError) this.pendingAssistantError = event.finalError;
          this.terminalOutcome = "stopped";
        }
        break;
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
      const key = `pending-user:${crypto.randomUUID()}`;
      this.pendingSteering.push(key);
      this.livePendingUser(key, fullText);
      try {
        await this.session.steer(fullText, images.length > 0 ? images : undefined);
      } catch (error) {
        this.pendingSteering.splice(this.pendingSteering.indexOf(key), 1);
        this.liveConsumePendingUser(key);
        throw error;
      }
      return;
    }

    let accepted = false;
    const acceptedPrompt = Symbol("accepted prompt");
    const { promise: acceptance, resolve: resolveAcceptance, reject: rejectAcceptance } = Promise.withResolvers<void>();
    const thisRuntime = this;
    const promptOptions: AgentPromptPreflightOptions = {
      preflightResult(success) {
        if (!success) return;
        accepted = true;
        // Pi invokes this immediately before starting the agent loop. Keep the
        // accepted prompt pending until its persisted user entry so handled
        // extension commands never create a speculative user/Working section or
        // leave the Agent busy without a matching agent_settled.
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
    this.finishRun("stopped");
    this.setBusy(false);
    void this.refreshStats().catch((error) => {
      console.error("Could not refresh Agent stats after abort", normalizedPromiseError(error));
    });
  }

  private async finishDisposal(): Promise<void> {
    this.detachTranscript();
    const unsubscribe = this.unsubscribeSession;
    this.unsubscribeSession = undefined;
    unsubscribe?.();
    try {
      await this.abort();
    } finally {
      try { await this.delegation.dispose(); } finally { this.setBusy(false); }
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
    this.session.setActiveToolsByName(this.session.getActiveToolNames());
    await this.refreshStats();
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.assertActive();
    this.session.setThinkingLevel(level);
    this.session.setActiveToolsByName(this.session.getActiveToolNames());
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
      try { await created.session.abort(); } finally { await created.delegation.dispose(); }
      throw error;
    }
    this.unsubscribeSession?.();
    this.detachTranscript();
    try {
      await this.delegation.dispose();
    } catch (error) {
      try { await created.session.abort(); } finally { await created.delegation.dispose(); }
      throw error;
    }
    this.delegation = created.delegation;
    this.session = created.session;
    this.toolsForModel = created.toolViews;
    this.serviceTiers = created.serviceTiers;
    this.sessionFile = agent.path;
    this.selectBranch();
    try {
      this.subscribeToSession();
      this.attachTranscript();
    } catch (error) {
      this.unsubscribeSession?.();
      this.detachTranscript();
      try { await created.session.abort(); } finally { await created.delegation.dispose(); }
      throw error;
    }
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
      this.selectBranch();
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
        this.notice("info", "Summarizing the abandoned branch…");
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
        this.selectBranch();
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
      this.selectBranch();
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
  try {
    return new RealAgentRuntime(agent, created.session, created.toolViews, created.serviceTiers, options, created.delegation);
  } catch (error) {
    try { await created.session.abort(); } finally { await created.delegation.dispose(); }
    throw error;
  }
}
