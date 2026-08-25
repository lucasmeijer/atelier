import { randomUUID } from "node:crypto";
import { isJsonObject, type JsonObject, type JsonValue } from "@atelier/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { composerServiceTier, composerThinkingLevel, composerThinkingLevels, configuredModelOptionViews, modelRefValue, selectedComposerModel, type ModelRef } from "./model-state.ts";
import type { AgentServiceTier } from "./service-tier.ts";
import { contextualDiffLines, diffStats, parseUnifiedPatchHunks, type DiffDisplayLine, type DiffOperation } from "./diff.ts";
import { embeddedBashCommandHtml, formatBashCommandForDisplay } from "./embedded-code.ts";
import { highlightCodeHtmlForPath, renderMarkdown, renderStreamingMarkdownSnapshot } from "@atelier/markdown";
import { domId, escapeHtml } from "./html.ts";
import type { WorkspaceAgentConversationInfo } from "./session-store.ts";
import { thinkingBlockRendererFor } from "./thinking-block-renderers.ts";
import {
  formatCost,
  formatDuration,
  formatTokens,
  type TranscriptItem,
  type WorkingTranscriptItem,
  type SessionImageRef,
  type ToolView,
  type ToolViewDetails,
} from "./transcript.ts";

export interface AgentRenderContext {
  workspaceId: string;
  label: string;
  model?: ModelRef;
}

export function agentConversationKey(label: string): string {
  return `agent:${label}`;
}

// ---------------------------------------------------------------------------
// Dom ids
// ---------------------------------------------------------------------------

function prefix(ctx: AgentRenderContext): string {
  return domId("ag", ctx.workspaceId, ctx.label);
}

export const ids = {
  pane: (ctx: AgentRenderContext) => `${prefix(ctx)}_pane`,
  transcript: (ctx: AgentRenderContext) => `${prefix(ctx)}_transcript`,
  systemPrompt: (ctx: AgentRenderContext) => `${prefix(ctx)}_system_prompt`,
  item: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_item`, key),
  workingItems: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_working_items`, key),
  itemText: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext`, key),
  itemTextStable: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext_stable`, key),
  itemTextTail: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_itemtext_tail`, key),
  itemSummary: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_summary`, key),
  itemSummaryContent: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_summary_content`, key),
  itemCompletion: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_completion`, key),
  itemCompletionTabs: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_completion_tabs`, key),
  detailFrame: (ctx: AgentRenderContext, key: string) => domId(`${prefix(ctx)}_detail`, key),
  stats: (ctx: AgentRenderContext) => `${prefix(ctx)}_stats`,
  actions: (ctx: AgentRenderContext) => `${prefix(ctx)}_actions`,
  abortForm: (ctx: AgentRenderContext) => `${prefix(ctx)}_abort_form`,
  attachRow: (ctx: AgentRenderContext) => `${prefix(ctx)}_attach`,
  chip: (ctx: AgentRenderContext, attachmentId: string) => domId(`${prefix(ctx)}_chip`, attachmentId),
  draftAttachRow: (draftId: string) => domId("agent_draft_attach", draftId),
  draftChip: (draftId: string, attachmentId: string) => domId("agent_draft_chip", draftId, attachmentId),
  notices: (ctx: AgentRenderContext) => `${prefix(ctx)}_notices`,
};

function agentPath(ctx: AgentRenderContext, suffix: string): string {
  return `/workspaces/${encodeURIComponent(ctx.workspaceId)}/agents/${encodeURIComponent(ctx.label)}${suffix}`;
}

function markdown(ctx: AgentRenderContext, text: string): string {
  return renderMarkdown(ctx.workspaceId, text);
}

function transcriptRow(html: string): string {
  return `<div class="agent-row">${html}</div>`;
}

function renderMarkdownRow(ctx: AgentRenderContext, text: string, className = "agent-md"): string {
  const body = markdown(ctx, text);
  return body ? transcriptRow(`<div class="${className}">${body}</div>`) : "";
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

interface AgentModelOption {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
  available?: boolean;
  unavailableReason?: string;
}

export interface AgentStatsView {
  contextPercent: number | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  modelName: string | undefined;
  provider: string | undefined;
  thinkingLevel: string;
  thinkingLevels: string[];
  serviceTier?: AgentServiceTier;
  models: AgentModelOption[];
}

export interface AgentToolDefinitionView {
  name: string;
  description: string;
  parameters: unknown;
}

type ToolArgumentKey = "command" | "path" | "file_path" | "content" | "offset" | "limit" | "timeout" | "edits" | "oldText" | "newText";

const toolStringArgumentSchema = Type.String();
const toolNumberArgumentSchema = Type.Number();
const diffOperationSchema = Type.Object({
  oldText: Type.String(),
  newText: Type.String(),
});

export interface AgentModelContextView {
  systemPrompt: string;
  tools: AgentToolDefinitionView[];
}

export interface AgentPaneState {
  transcriptHtml: string;
  busy: boolean;
  stats: AgentStatsView;
  /** Identifies the last runtime mutation represented by this pane state. */
  snapshotCursor?: string;
}

const agentAttachmentDropAction = "dragover->agent-attachments#dragOver dragleave->agent-attachments#dragLeave drop->agent-attachments#drop";

function agentAttachmentDropAttrs(uploadUrl: string): string {
  return `data-agent-attachments-upload-url-value="${escapeHtml(uploadUrl)}" data-action="${agentAttachmentDropAction}"`;
}

export async function renderAgentPane(ctx: AgentRenderContext, agent: WorkspaceAgentConversationInfo, state: AgentPaneState, options: { visible?: boolean } = {}): Promise<string> {
  return await renderAgentPaneFrame(ctx, agent, state, options);
}

const pendingAgentStats: AgentStatsView = {
  contextPercent: null,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  modelName: undefined,
  provider: undefined,
  thinkingLevel: "",
  thinkingLevels: [],
  models: [],
};

export async function renderPendingAgentPane(ctx: AgentRenderContext, agent: WorkspaceAgentConversationInfo, options: { visible?: boolean } = {}): Promise<string> {
  return await renderAgentPaneFrame(ctx, agent, {
    transcriptHtml: `<div class="agent-starting"><span class="agent-starting-spinner" aria-hidden="true"></span><div><b>Starting ${escapeHtml(ctx.label)}…</b><span>Loading model settings and workspace instructions.</span></div></div>`,
    busy: false,
    stats: pendingAgentStats,
  }, options);
}

async function renderAgentPaneFrame(ctx: AgentRenderContext, agent: WorkspaceAgentConversationInfo, state: AgentPaneState, options: { visible?: boolean } = {}): Promise<string> {
  const key = agentConversationKey(agent.label);
  const draftId = randomUUID();
  const attachRowId = ids.attachRow(ctx);
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(attachRowId)}`;
  return `<section id="${domId("agent_pane", ctx.workspaceId, agent.label)}" class="agent-conversation-pane ${options.visible ? "visible" : ""}" data-agent-conversation-source="${escapeHtml(key)}">
    <div class="agent-pane" id="${ids.pane(ctx)}"
      data-controller="agent-pane agent-attachments"
      data-agent-pane-workspace-id-value="${escapeHtml(ctx.workspaceId)}"
      data-agent-pane-label-value="${escapeHtml(ctx.label)}"
      ${state.snapshotCursor ? `data-agent-pane-snapshot-cursor-value="${escapeHtml(state.snapshotCursor)}"` : ""}
      ${agentAttachmentDropAttrs(uploadUrl)}>
      <div class="agent-transcript" id="${ids.transcript(ctx)}" data-agent-pane-target="transcript">${state.transcriptHtml}</div>
      ${await renderAgentComposer({
        ctx,
        action: agentPath(ctx, "/messages"),
        draftId,
        placeholder: `Message ${ctx.label}… (drop files anywhere)`,
        formTarget: true,
        includePaneActions: true,
        busy: state.busy,
        stats: state.stats,
        dropTarget: false,
      })}
      ${renderMessageNavigatorDialog()}
      ${renderRewindDialog(ctx)}
    </div>
  </section>`;
}

interface AgentComposerRenderOptions {
  ctx?: AgentRenderContext;
  action: string;
  draftId: string;
  placeholder: string;
  initialText?: string;
  formTarget?: boolean;
  includePaneActions?: boolean;
  busy?: boolean;
  stats?: AgentStatsView;
  submitLabel?: string;
  submitShortcut?: string;
  formId?: string;
  rows?: number;
  formActions?: string;
  formTurbo?: boolean;
  launchSettings?: { frameId: string; url: string };
  dropTarget?: boolean;
}

export async function renderAgentComposer(options: AgentComposerRenderOptions): Promise<string> {
  const draftId = options.draftId;
  const attachRowId = options.ctx ? ids.attachRow(options.ctx) : ids.draftAttachRow(draftId);
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(attachRowId)}`;
  const actionAttrs = ["turbo:submit-end->agent-pane#submitted", "click->agent-pane#focusInput"];
  const targetAttrs = options.formTarget ? ` data-agent-pane-target="form"` : "";
  const completionsEnabled = Boolean(options.ctx);
  const inputTarget = [
    options.formTarget ? `data-agent-pane-target="input"` : "",
    completionsEnabled ? `data-agent-completions-target="input"` : "",
  ].filter(Boolean).join(" ");
  const inputActionsList = [
    ...(completionsEnabled ? ["keydown->agent-completions#keydown", "input->agent-completions#input"] : []),
    ...(options.formTarget ? ["keydown->agent-pane#inputKeydown", "input->agent-pane#promptChanged"] : []),
  ];
  const inputActions = inputActionsList.length ? ` data-action="${inputActionsList.join(" ")}"` : "";
  const shortcut = options.submitShortcut ? ` <kbd>${escapeHtml(options.submitShortcut)}</kbd>` : "";
  const actions = options.includePaneActions && options.ctx
    ? `<span id="${ids.actions(options.ctx)}">${renderPromptActions(options.ctx, Boolean(options.busy))}</span>`
    : `<button class="agent-btn primary" type="submit" name="mode" value="send">${escapeHtml(options.submitLabel ?? "Send")}${shortcut}</button>`;
  const formId = options.formId ?? `agent_composer_${draftId}`;
  const statbar = options.stats && options.ctx
    ? `<div class="agent-statbar" id="${ids.stats(options.ctx)}">${renderStatsBar(options.ctx, options.stats)}</div>`
    : `<div class="agent-statbar">${await renderAgentLaunchSettings({ ...options.launchSettings!, formId })}</div>`;
  const turboAttr = options.formTurbo === undefined ? "" : ` data-turbo="${options.formTurbo ? "true" : "false"}"`;
  const dropTarget = options.dropTarget ?? true;
  const completionControllers = [dropTarget ? "agent-attachments" : "", completionsEnabled ? "agent-completions" : ""].filter(Boolean).join(" ");
  const promptAttrs = [
    completionControllers ? `data-controller="${completionControllers}"` : "",
    dropTarget ? agentAttachmentDropAttrs(uploadUrl) : "",
    options.ctx ? `data-agent-completions-url-value="${escapeHtml(agentPath(options.ctx, "/completions"))}"` : "",
  ].filter(Boolean).join(" ");
  const composerOverlays = [
    completionsEnabled ? `<div class="agent-completion-menu-host" data-agent-completions-target="menu" hidden></div>` : "",
    options.includePaneActions && options.ctx ? renderTranscriptNavigation() : "",
  ].filter(Boolean).join("");
  return `<div class="agent-promptwrap"${promptAttrs ? ` ${promptAttrs}` : ""}>
        ${composerOverlays ? `<div class="agent-composer-overlays">${composerOverlays}</div>` : ""}
        <div class="agent-promptbox">
          <form id="${escapeHtml(formId)}" method="post" action="${escapeHtml(options.action)}"${turboAttr}${targetAttrs}${options.formTarget ? ` data-action="${actionAttrs.join(" ")}"` : options.formActions ? ` data-action="${escapeHtml(options.formActions)}"` : ""}>
            <input type="hidden" name="attachmentDraft" value="${escapeHtml(draftId)}">
            <div class="agent-attach-row" id="${attachRowId}" data-agent-attachments-target="row"></div>
            <textarea class="agent-input" name="text" rows="${options.rows ?? 2}" placeholder="${escapeHtml(options.placeholder)}" aria-label="${escapeHtml(options.placeholder)}"${inputTarget ? ` ${inputTarget}` : ""}${inputActions}>${escapeHtml(options.initialText ?? "")}</textarea>
            <div class="agent-prompt-actions">
              <span class="spacer"></span>
              ${actions}
            </div>
          </form>
          ${options.includePaneActions && options.ctx ? `<form id="${ids.abortForm(options.ctx)}" method="post" action="${escapeHtml(agentPath(options.ctx, "/abort"))}" hidden></form>` : ""}
          ${statbar}
        </div>
      </div>`;
}

async function renderAgentModelOptions(selectedModel?: string): Promise<string> {
  const selected = await selectedComposerModel(selectedModel);
  const models = await configuredModelOptionViews(selected);
  return models.map((model, index) => {
    const value = modelRefValue(model);
    return `<option value="${escapeHtml(value)}" data-provider="${escapeHtml(model.provider)}"${(selected ? value === modelRefValue(selected) : index === 0) ? " selected" : ""}${model.available ? "" : ` disabled data-unavailable-reason="${escapeHtml(model.unavailableReason ?? "Unavailable")}"`}>${escapeHtml(model.name)}</option>`;
  }).join("");
}

async function composerSettingsState(selectedModel?: string): Promise<{ selected: ModelRef | undefined; selectedThinkingLevel: string | undefined; thinkingLevels: string[]; serviceTier?: AgentServiceTier }> {
  const selected = await selectedComposerModel(selectedModel);
  return {
    selected,
    selectedThinkingLevel: await composerThinkingLevel(selected),
    thinkingLevels: await composerThinkingLevels(selected),
    serviceTier: await composerServiceTier(selected),
  };
}

function thinkingSelectHtml(formId: string, thinkingLevels: string[], selectedThinkingLevel: string | undefined): string {
  return thinkingLevels.length > 0
    ? `<select class="agent-sel" data-controller="agent-select-menu" name="level" form="${escapeHtml(formId)}" title="Thinking level">${thinkingLevels.map((level) => `<option value="${escapeHtml(level)}"${level === selectedThinkingLevel ? " selected" : ""}>${escapeHtml(level)}</option>`).join("")}</select>`
    : "";
}

function fastModeTitle(serviceTier: AgentServiceTier): string {
  return serviceTier === "priority" ? "Fast is on. Switch to Standard for the next model call." : "Switch to Fast for the next model call; uses plan limits faster.";
}

export async function renderAgentLaunchSettings(options: { frameId: string; formId: string; url: string; selectedModel?: string }): Promise<string> {
  const { selected, selectedThinkingLevel, thinkingLevels, serviceTier } = await composerSettingsState(options.selectedModel);
  const selectedValue = selected ? modelRefValue(selected) : "";
  return `<turbo-frame id="${escapeHtml(options.frameId)}"><span class="agent-stat-right">
<form method="get" action="${escapeHtml(options.url)}" data-controller="agent-autosubmit" data-turbo-frame="${escapeHtml(options.frameId)}">
<select class="agent-sel" data-controller="agent-model-menu" name="model" data-action="change->agent-autosubmit#submit" title="Model">${await renderAgentModelOptions(selectedValue || undefined)}</select>
</form>
<input type="hidden" name="model" value="${escapeHtml(selectedValue)}" form="${escapeHtml(options.formId)}">
${thinkingSelectHtml(options.formId, thinkingLevels, selectedThinkingLevel)}
${serviceTier ? `<label class="agent-fast-toggle" title="${fastModeTitle(serviceTier)}"><input type="checkbox" name="serviceTier" value="priority" form="${escapeHtml(options.formId)}" aria-label="Fast mode"${serviceTier === "priority" ? " checked" : ""}><span aria-hidden="true">⚡</span></label>` : ""}
</span></turbo-frame>`;
}

function renderTranscriptNavigation(): string {
  return `<div class="agent-transcript-navs">
    <button class="agent-transcript-nav" type="button" data-agent-pane-target="transcriptNav" data-action="agent-pane#jumpToLatestMessage" title="Jump to beginning of latest message" aria-label="Jump to beginning of latest message" aria-hidden="true" disabled>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16h12M10 4v9m-4-4 4 4 4-4"/></svg>
    </button>
    <button class="agent-transcript-nav" type="button" data-action="agent-pane#openMessageDialog" title="Browse your messages" aria-label="Browse your messages">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4.5h12M4 8.5h8M4 12.5h10"/><path d="M5.5 15.5h8l2.5-2.5v-8.5H4v9.5a1.5 1.5 0 0 0 1.5 1.5Z"/></svg>
    </button>
  </div>`;
}

function renderMessageNavigatorDialog(): string {
  return `<dialog class="agent-message-dialog" data-agent-pane-target="messageDialog" data-action="click->agent-pane#messageDialogClicked keydown->agent-pane#messageDialogKeydown" aria-label="Your messages">
    <div class="agent-message-list" data-agent-pane-target="messageList"></div>
  </dialog>`;
}

export function renderPromptActions(ctx: AgentRenderContext, busy: boolean): string {
  const busyAttrs = busy ? ` data-agent-busy="true" data-agent-abort-form-id="${ids.abortForm(ctx)}"` : ` data-agent-busy="false"`;
  const label = busy ? "Steer" : "Send";
  const value = busy ? "steer" : "send";
  const title = busy ? "Deliver a steering note while the agent keeps working" : "Send prompt";
  return `<button class="agent-btn primary agent-sendstop" type="submit" name="mode" value="${value}" title="${title}"${busyAttrs}>${label} <kbd>⌘↩</kbd></button>`;
}

export function renderStatsBar(ctx: AgentRenderContext, stats: AgentStatsView): string {
  const percent = stats.contextPercent;
  const meter = percent === null
    ? ""
    : `<span class="agent-stat" title="Context window used"><span class="agent-ctx-meter"><i style="width:${Math.min(100, Math.max(0, percent)).toFixed(0)}%"></i></span><b>${percent.toFixed(0)}%</b></span>`;
  const modelOptions = stats.models.map((model) => {
    const available = model.available !== false;
    return `<option value="${escapeHtml(`${model.provider}::${model.id}`)}" data-provider="${escapeHtml(model.provider)}"${model.selected ? " selected" : ""}${available ? "" : ` disabled data-unavailable-reason="${escapeHtml(model.unavailableReason ?? "Unavailable")}"`}>${escapeHtml(model.name)}</option>`;
  }).join("");
  const thinkingOptions = stats.thinkingLevels.map((level) =>
    `<option value="${escapeHtml(level)}"${level === stats.thinkingLevel ? " selected" : ""}>${escapeHtml(level)}</option>`).join("");
  return `${meter}
<span class="agent-stat" title="Tokens up (input)">↑ <b>${formatTokens(stats.inputTokens)}</b></span>
<span class="agent-stat" title="Tokens down (output)">↓ <b>${formatTokens(stats.outputTokens)}</b></span>
<span class="agent-stat" title="Session cost"><b>${formatCost(stats.cost)}</b></span>
<span class="agent-stat-right">
<form method="post" action="${escapeHtml(agentPath(ctx, "/model"))}" data-controller="agent-autosubmit"><select class="agent-sel" data-controller="agent-model-menu" name="model" data-action="change->agent-autosubmit#submit" title="Model">${modelOptions || `<option>${escapeHtml(stats.modelName ?? "no model")}</option>`}</select></form>
${stats.thinkingLevels.length > 0 ? `<form method="post" action="${escapeHtml(agentPath(ctx, "/thinking"))}" data-controller="agent-autosubmit"><select class="agent-sel" data-controller="agent-select-menu" name="level" data-action="change->agent-autosubmit#submit" title="Thinking level">${thinkingOptions}</select></form>` : ""}
${stats.serviceTier ? `<form method="post" action="${escapeHtml(agentPath(ctx, "/service-tier"))}"><button class="agent-fast-toggle${stats.serviceTier === "priority" ? " active" : ""}" type="submit" name="serviceTier" value="${stats.serviceTier === "priority" ? "default" : "priority"}" aria-label="Fast mode" aria-pressed="${stats.serviceTier === "priority"}" title="${fastModeTitle(stats.serviceTier)}"><span aria-hidden="true">⚡</span></button></form>` : ""}
</span>`;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

function transcriptItemPath(ctx: AgentRenderContext, key: string, query = ""): string {
  return `${agentPath(ctx, `/transcript-items/${encodeURIComponent(key)}`)}${query}`;
}

export function renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView): string {
  return `${renderModelContextCard(ctx, modelContext)}${items.map((item) => renderTranscriptItem(ctx, item)).join("")}<div class="agent-notices" id="${ids.notices(ctx)}"></div>`;
}

function renderModelContextCard(ctx: AgentRenderContext, modelContext: AgentModelContextView): string {
  const prompt = modelContext.systemPrompt.trim();
  const tools = modelContext.tools;
  if (!prompt && tools.length === 0) return "";
  const meta = [prompt ? "system-prompt.md" : undefined, tools.length ? `tools.json (${tools.length})` : undefined].filter(Boolean).join(" · ");
  return transcriptRow(`<details class="agent-tool tool-model-context" data-agent-historical-detail data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load"><summary class="agent-tool-head"><span class="agent-tool-status ok"></span><code class="agent-tool-name">model_context</code><span class="agent-tool-args">${escapeHtml(meta)}</span></summary><turbo-frame id="${ids.detailFrame(ctx, "model-context")}" data-agent-lazy-detail-target="frame" data-controller="agent-tail-frame" data-action="turbo:frame-load->agent-tail-frame#loaded" data-src="${escapeHtml(transcriptItemPath(ctx, "model-context"))}"></turbo-frame></details>`);
}

export function renderModelContextDetailFrame(ctx: AgentRenderContext, modelContext: AgentModelContextView): string {
  const prompt = modelContext.systemPrompt.trim();
  const blocks = [prompt ? codeBlockHtml(prompt, "system-prompt.md") : "", modelContext.tools.length ? codeBlockHtml(JSON.stringify(modelContext.tools, null, 2), "tools.json") : ""].filter(Boolean).join("");
  return `<turbo-frame id="${ids.detailFrame(ctx, "model-context")}"><div class="agent-tool-detail">${detailFullscreen("MODEL CONTEXT", blocks)}</div></turbo-frame>`;
}

function sessionImageUrl(ctx: AgentRenderContext, image: SessionImageRef): string {
  return `/workspaces/${encodeURIComponent(ctx.workspaceId)}/agents/${encodeURIComponent(ctx.label)}/session-images/${encodeURIComponent(image.entryId)}/${image.contentIndex}`;
}

function renderUserMessage(ctx: AgentRenderContext, user: { text: string; images: SessionImageRef[] }): string {
  const images = user.images.length ? `<div class="agent-user-attachments">${user.images.map((image) => `<img${fullscreenAttributes("attachment", "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="attachment" loading="lazy">`).join("")}</div>` : "";
  return transcriptRow(`<div class="agent-user" data-agent-user-text="${escapeHtml(user.text)}"><div class="agent-user-bubble">${markdown(ctx, user.text)}${images}</div></div>`);
}

function rewindHtml(ctx: AgentRenderContext, item: TranscriptItem): string {
  if (!item.rewindEntryId) return "";
  const preview = item.type === "user" || item.type === "text" || item.type === "thinking" || item.type === "note" ? item.text : item.type === "tool" ? item.tool.name : "this point";
  return `<div class="agent-rewind-zone"><button class="agent-rewind-btn" type="button" data-action="agent-pane#openRewind" data-entry-id="${escapeHtml(item.rewindEntryId)}" data-user-text="${escapeHtml(preview)}" title="Rewind to here">⟲ Rewind to here</button></div>`;
}

function renderStreamingTextBody(ctx: AgentRenderContext, key: string, text: string): string {
  const snapshot = renderStreamingMarkdownSnapshot(ctx.workspaceId, text);
  return `<div class="agent-md agent-itext-md agent-stream-markdown" id="${ids.itemText(ctx, key)}"><div id="${ids.itemTextStable(ctx, key)}">${snapshot.stableHtml}</div><div id="${ids.itemTextTail(ctx, key)}">${snapshot.tailHtml}</div></div>`;
}

export function renderTranscriptItem(ctx: AgentRenderContext, item: TranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  if (item.type === "working") return renderWorkingSection(ctx, item);
  const id = ids.item(ctx, item.key);
  let body = "";
  if (item.type === "user") body = renderUserMessage(ctx, item);
  else if (item.type === "thinking") body = renderThinkingItem(ctx, item);
  else if (item.type === "text") body = item.live
    ? transcriptRow(renderStreamingTextBody(ctx, item.key, item.text))
    : renderMarkdownRow(ctx, item.text, item.final ? "agent-md agent-final" : "agent-md agent-itext-md");
  else if (item.type === "tool") body = transcriptRow(renderToolCard(ctx, item.key, item.tool, options));
  else if (item.type === "note") body = renderMarkdownRow(ctx, item.text, `agent-note ${escapeHtml(item.tone)}`);
  else body = transcriptRow(`<div class="agent-error">${escapeHtml(item.text)}</div>`);
  return `<div class="agent-item" id="${id}">${rewindHtml(ctx, item)}${body}</div>`;
}

function renderWorkingSection(ctx: AgentRenderContext, section: WorkingTranscriptItem): string {
  if (section.completedAt !== undefined && section.items.length === 0) return "";
  const label = section.completedAt !== undefined
    ? `Worked for ${formatDuration(section.completedAt - section.startedAt)}`
    : section.stoppedAt !== undefined
      ? `Stopped after ${formatDuration(section.stoppedAt - section.startedAt)}`
      : "Working";
  const items = section.items.map((item) => renderTranscriptItem(ctx, item, { live: section.live, open: section.live })).join("");
  return `<details class="agent-working" id="${ids.item(ctx, section.key)}"${section.completedAt === undefined ? " open" : ""}><summary class="agent-working-summary"><span class="agent-working-chevron" aria-hidden="true"></span>${label}</summary><div class="agent-working-items" id="${ids.workingItems(ctx, section.key)}">${items}</div></details>`;
}

function renderThinkingItem(ctx: AgentRenderContext, item: Extract<TranscriptItem, { type: "thinking" }>): string {
  const renderer = thinkingBlockRendererFor(ctx.model);
  return transcriptRow(renderer({ contentId: ids.itemText(ctx, item.key), text: item.text }));
}

export function renderTranscriptItemDetailFrame(ctx: AgentRenderContext, item: TranscriptItem, options: { count?: number } = {}): string {
  const frameId = ids.detailFrame(ctx, item.key);
  let html = "";
  if (item.type === "tool") {
    html = renderToolDetail(ctx, item.key, item.tool, options.count ?? 100);
  }
  return `<turbo-frame id="${frameId}">${html}</turbo-frame>`;
}

function statusHtml(status: ToolView["status"]): string {
  const state = status === "streaming" || status === "running" ? "running" : status === "error" ? "error" : "ok";
  return `<span class="agent-tool-status ${state}"></span>`;
}

function tokenSummary(tool: ToolView, direction: "up" | "down"): string {
  return tool.tokenCount === undefined ? "" : `${formatTokens(tool.tokenCount)} tok <span class="agent-token-arrow">${direction === "up" ? "↑" : "↓"}</span>`;
}

function summaryHtml(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).map((part) => escapeHtml(part!)).join(" · ");
}

function bashSummary(tool: ToolView): string {
  const details = toolDetails(tool);
  const timeout = tool.timeoutSeconds ?? numberArg(toolArgs(tool), "timeout") ?? 600;
  if (tool.status === "running") return "";
  const duration = tool.durationMs === undefined ? "" : `${formatDuration(tool.durationMs)} / ${formatDuration(timeout * 1000)}`;
  const outcome = details?.timedOut === true ? "timed out" : details?.aborted === true ? "aborted" : details?.exitCode !== undefined ? `exitcode ${details.exitCode}` : "";
  return [summaryHtml([duration, outcome]), tokenSummary(tool, "up")].filter(Boolean).join(" · ");
}

function toolSummaryHtml(tool: ToolView): string {
  if (tool.name === "bash") return bashSummary(tool);
  if (tool.name === "read") {
    const image = tool.resultImages?.[0];
    const imageMeta = image ? [image.width && image.height ? `${image.width}×${image.height}` : "", image.mimeType ?? ""].filter(Boolean).join(" · ") : "";
    return [summaryHtml([pathSummary(tool, formatReadRange(toolArgs(tool))), imageMeta]), image ? "" : tokenSummary(tool, "up")].filter(Boolean).join(" · ");
  }
  if (tool.name === "write") return [summaryHtml([pathSummary(tool)]), tokenSummary(tool, "down")].filter(Boolean).join(" · ");
  if (tool.name === "edit") {
    const operations = getEditOperations(toolArgs(tool));
    const stats = diffStats(operations);
    const editCount = operations.length ? `${operations.length} ${operations.length === 1 ? "edit" : "edits"}` : "";
    const changes = operations.length ? `+${stats.added} −${stats.deleted}` : "";
    return [summaryHtml([pathSummary(tool), editCount, changes]), tokenSummary(tool, "down")].filter(Boolean).join(" · ");
  }
  return escapeHtml(genericToolSummary(tool));
}

function runningElapsedHtml(tool: ToolView): string {
  if (!tool.startedAt) return "";
  return `<span class="agent-tool-elapsed agent-duration-slot" data-controller="agent-elapsed" data-agent-elapsed-since-value="${tool.startedAt}"${tool.timeoutSeconds ? ` data-agent-elapsed-max-value="${tool.timeoutSeconds}"` : ""}><span data-agent-elapsed-target="time">0s</span></span>`;
}

function toolForRender(original: ToolView): ToolView {
  return original.status === "streaming" && original.argsStream
    ? { ...original, args: parseKnownStreamedArgs(original.name, original.argsStream) }
    : original;
}

function toolSummaryContentHtml(tool: ToolView): string {
  const summary = toolSummaryHtml(tool);
  return `<code class="agent-tool-name">${escapeHtml(tool.name || "tool")}</code>${summary ? `<span class="agent-tool-sep">·</span><span class="agent-tool-args${tool.status === "error" ? " error" : ""}">${summary}</span>` : ""}${tool.status === "running" && tool.name === "bash" ? `<span class="agent-tool-sep">·</span>${runningElapsedHtml(tool)}` : ""}`;
}

export interface ActiveToolContent {
  summary: string;
  detail?: string;
}

export function renderActiveToolContent(ctx: AgentRenderContext, key: string, original: ToolView): ActiveToolContent {
  const tool = toolForRender(original);
  return {
    summary: toolSummaryContentHtml(tool),
    detail: tool.name === "edit" ? undefined : renderToolDetail(ctx, key, tool, 100),
  };
}

function toolSummaryCardHtml(ctx: AgentRenderContext, key: string, tool: ToolView): string {
  return `<span id="${ids.itemSummary(ctx, key)}" class="agent-tool-head">${statusHtml(tool.status)}<span id="${ids.itemSummaryContent(ctx, key)}" class="agent-tool-summary-content">${toolSummaryContentHtml(tool)}</span></span>`;
}

export function renderToolSummary(ctx: AgentRenderContext, key: string, tool: ToolView): string {
  return toolSummaryCardHtml(ctx, key, toolForRender(tool));
}

function tailFrameAttributes(ctx: AgentRenderContext, key: string): string {
  return `id="${ids.detailFrame(ctx, key)}" data-controller="agent-tail-frame" data-action="turbo:frame-load->agent-tail-frame#loaded"`;
}

function renderToolCard(ctx: AgentRenderContext, key: string, original: ToolView, options: { open?: boolean; live?: boolean } = {}): string {
  const tool = toolForRender(original);
  const summary = toolSummaryCardHtml(ctx, key, tool);
  const active = tool.status === "streaming" || tool.status === "running";
  if (active && tool.name === "edit") return `<div class="agent-tool agent-tool-summary-only ${toolClass(tool.name)}">${summary}</div>`;
  const open = Boolean(options.open || active);
  if (!options.live && !active) {
    return `<details class="agent-tool ${toolClass(tool.name)}${tool.status === "error" ? " error" : ""}" data-agent-historical-detail data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load"><summary>${summary}</summary><turbo-frame ${tailFrameAttributes(ctx, key)} data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, key))}"></turbo-frame></details>`;
  }
  return `<details class="agent-tool ${toolClass(tool.name)}${active ? " active" : ""}${tool.status === "error" ? " error" : ""}"${open ? " open" : ""}><summary>${summary}</summary><turbo-frame ${tailFrameAttributes(ctx, key)} class="agent-tool-detail-host">${renderToolDetail(ctx, key, tool, 100)}</turbo-frame></details>`;
}

function detailFullscreen(title: string, html: string): string {
  return `<div class="agent-detail-fullscreen"${fullscreenAttributes(title)}>${html}<template data-atelier-fullscreen-target="content">${html}</template></div>`;
}

function sourceRegionHtml(title: string, body: string, className = "agent-source-region"): string {
  return detailFullscreen(title, `<section class="${className}"><div class="agent-region-title">${escapeHtml(title)}</div>${body}</section>`);
}

function sourceRegion(title: string, code: string, path: string | undefined, className?: string): string {
  return sourceRegionHtml(title, codeBlockHtml(code, path, "agent-tool-code"), className);
}

interface TextWindow {
  text: string;
  hidden: number;
}

function textWindow(text: string, mode: "first" | "last", count: number): TextWindow {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines.length <= count) return { text, hidden: 0 };
  return mode === "first" ? { text: lines.slice(0, count).join("\n"), hidden: lines.length - count } : { text: lines.slice(-count).join("\n"), hidden: lines.length - count };
}

function moreLink(ctx: AgentRenderContext, key: string, count: number, hidden: number, direction: "first" | "last"): string {
  if (!hidden) return "";
  const increment = Math.min(500, hidden);
  const next = count + increment;
  return `<div class="agent-more-lines"><a href="${escapeHtml(transcriptItemPath(ctx, key, `?count=${next}`))}" data-turbo-frame="${ids.detailFrame(ctx, key)}" data-action="click->agent-tail-frame#prepare" data-direction="${direction}">show ${increment} more ${increment === 1 ? "line" : "lines"}</a></div>`;
}

function tailOutput(content: string, pagination: string, direction: "first" | "last"): string {
  return `<div class="agent-tail-output" data-agent-tail-direction="${direction}">${direction === "last" ? pagination : ""}${content}${direction === "first" ? pagination : ""}</div>`;
}

interface BashViews {
  display: string;
  model: string;
  same: boolean;
  resultWindow: TextWindow;
  modelWindow: TextWindow;
}

function bashViews(tool: ToolView, count: number): BashViews {
  const details = toolDetails(tool);
  const display = details?.displayAnsi?.trimEnd() ?? "";
  const model = trimResult(tool);
  return { display, model, same: !display || display === model, resultWindow: textWindow(display || model || "(no output)", "last", count), modelWindow: textWindow(model || "(no output)", "last", count) };
}

function bashCopyButton(): string {
  return `<button type="button" class="agent-tool-copy" data-controller="agent-copy" data-action="click->agent-copy#copy" title="Copy selected Bash output" aria-label="Copy selected Bash output"><span class="agent-tool-copy-icon" aria-hidden="true">⧉</span></button>`;
}

export function renderObservedBashTabs(key: string, tool: ToolView): string {
  const group = `bash-observed-${domIdFragment(key)}`;
  const hasModel = !bashViews(tool, 100).same;
  return `<div class="agent-observed-tabs"><input type="radio" name="${group}" id="${group}-live" checked><label for="${group}-live">LIVE TERMINAL</label><input type="radio" name="${group}" id="${group}-result"><label for="${group}-result">RESULT</label>${hasModel ? `<input type="radio" name="${group}" id="${group}-model"><label for="${group}-model">AS SEEN BY MODEL</label>` : ""}${bashCopyButton()}</div>`;
}

export function renderObservedBashCompletion(ctx: AgentRenderContext, key: string, tool: ToolView, count = 100): string {
  const views = bashViews(tool, count);
  const result = views.display ? `<pre class="agent-tool-result agent-tool-ansi">${bashOutputHtml(views.resultWindow.text)}</pre>` : `<pre class="agent-tool-result">${escapeHtml(views.resultWindow.text)}</pre>`;
  const fullResult = views.display ? `<pre class="agent-tool-result agent-tool-ansi">${bashOutputHtml(views.display)}</pre>` : `<pre class="agent-tool-result">${escapeHtml(views.model || "(no output)")}</pre>`;
  const resultWindow = tailOutput(result, moreLink(ctx, key, count, views.resultWindow.hidden, "last"), "last");
  const modelWindow = tailOutput(`<pre class="agent-tool-result">${escapeHtml(views.modelWindow.text)}</pre>`, moreLink(ctx, key, count, views.modelWindow.hidden, "last"), "last");
  return `<div class="agent-observed-result">${fullscreenSourceRegion("RESULT", resultWindow, fullResult)}</div>${views.same ? "" : `<div class="agent-observed-model">${fullscreenSourceRegion("AS SEEN BY MODEL", modelWindow, `<pre class="agent-tool-result">${escapeHtml(views.model || "(no output)")}</pre>`)}</div>`}`;
}

function comparisonTabs(group: string, primaryLabel: string, trailingHtml = ""): string {
  return `<div class="agent-region-tabs"><input type="radio" name="${group}" id="${group}-primary" checked><label for="${group}-primary">${primaryLabel}</label><input type="radio" name="${group}" id="${group}-model"><label for="${group}-model">AS SEEN BY MODEL</label>${trailingHtml}</div>`;
}

function renderBashResultViews(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const { display, model, same, resultWindow, modelWindow } = bashViews(tool, count);
  const result = display ? `<pre class="agent-tool-result agent-tool-ansi">${bashOutputHtml(resultWindow.text)}</pre>` : `<pre class="agent-tool-result">${escapeHtml(resultWindow.text)}</pre>`;
  const resultHtml = tailOutput(result, moreLink(ctx, key, count, resultWindow.hidden, "last"), "last");
  const fullResult = display ? `<pre class="agent-tool-result agent-tool-ansi">${bashOutputHtml(display)}</pre>` : `<pre class="agent-tool-result">${escapeHtml(model || "(no output)")}</pre>`;
  if (same) return fullscreenSourceRegion("RESULT", `<section class="agent-bash-output"><div class="agent-region-title">RESULT${bashCopyButton()}</div>${resultHtml}</section>`, fullResult);
  const group = `bash-view-${domIdFragment(key)}`;
  const modelHtml = tailOutput(`<pre class="agent-tool-result">${escapeHtml(modelWindow.text)}</pre>`, moreLink(ctx, key, count, modelWindow.hidden, "last"), "last");
  return `<section class="agent-bash-output">${comparisonTabs(group, "RESULT", bashCopyButton())}<div class="agent-region-pane region-primary-pane result-pane">${fullscreenSourceRegion("RESULT", resultHtml, fullResult)}</div><div class="agent-region-pane region-model-pane model-pane">${fullscreenSourceRegion("AS SEEN BY MODEL", modelHtml, `<pre class="agent-tool-result">${escapeHtml(model || "(no output)")}</pre>`)}</div></section>`;
}

function renderBashCommand(key: string, command: string): string {
  const formatted = formatBashCommandForDisplay(command);
  const commandBody = embeddedBashCommandHtml(command, formatted) ?? codeBlockHtml(formatted, "command.sh", "agent-tool-code");
  if (formatted === command && !commandBody.includes("data-atelier-display-formatted")) return sourceRegionHtml("COMMAND", commandBody, "agent-bash-command");

  const group = `bash-command-${domIdFragment(key)}`;
  const modelBody = codeBlockHtml(command, "command.sh", "agent-tool-code");
  return `<section class="agent-bash-command">${comparisonTabs(group, "COMMAND")}<div class="agent-region-pane region-primary-pane">${fullscreenSourceRegion("COMMAND", commandBody, commandBody)}</div><div class="agent-region-pane region-model-pane">${fullscreenSourceRegion("AS SEEN BY MODEL", modelBody, modelBody)}</div></section>`;
}

function renderBashDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const command = stringArg(toolArgs(tool), "command") ?? "";
  const commandHtml = renderBashCommand(key, command);
  if (tool.status === "streaming") return `<div class="agent-tool-detail">${commandHtml}</div>`;
  if (tool.status === "running") {
    const terminal = tool.tmuxSession && tool.terminalVisible ? `<section class="agent-bash-output agent-observed-bash"><div id="${ids.itemCompletionTabs(ctx, key)}" class="agent-region-title">LIVE TERMINAL</div><div class="agent-terminal-viewport agent-observed-live"><div class="agent-tool-term agent-terminal-awaiting-output observable-terminal-host" data-controller="agent-term" data-agent-term-workspace-id-value="${escapeHtml(ctx.workspaceId)}" data-agent-term-label-value="${escapeHtml(ctx.label)}" data-agent-term-session-value="${escapeHtml(tool.tmuxSession)}"></div></div><div id="${ids.itemCompletion(ctx, key)}"></div></section>` : "";
    return `<div class="agent-tool-detail agent-bash-detail">${commandHtml}${terminal}</div>`;
  }
  return `<div class="agent-tool-detail agent-bash-detail">${commandHtml}${renderBashResultViews(ctx, key, tool, count)}</div>`;
}

function fullscreenSourceRegion(title: string, inlineHtml: string, fullHtml: string): string {
  return `<div class="agent-detail-fullscreen"${fullscreenAttributes(title)}>${inlineHtml}<template data-atelier-fullscreen-target="content">${fullHtml}</template></div>`;
}

function renderReadDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const images = toolResultImagesHtml(ctx, tool);
  const result = trimResult(tool);
  if (images) return `<div class="agent-tool-detail">${detailFullscreen("READ RESULT", `${images}${result ? `<pre class="agent-tool-note">${escapeHtml(result)}</pre>` : ""}`)}</div>`;
  const window = textWindow(result, "first", count);
  const path = stringArg(toolArgs(tool), "path", "file_path");
  const shown = tailOutput(codeBlockHtml(window.text, path), moreLink(ctx, key, count, window.hidden, "first"), "first");
  return `<div class="agent-tool-detail">${fullscreenSourceRegion("READ RESULT", shown, codeBlockHtml(result, path))}</div>`;
}

function renderWriteDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  const args = toolArgs(tool);
  const content = stringArg(args, "content") ?? "";
  const path = stringArg(args, "path", "file_path");
  const shown = tool.status === "streaming" || tool.status === "running" ? { text: content, hidden: 0 } : textWindow(content, "first", count);
  const preview = tailOutput(codeBlockHtml(shown.text, path), moreLink(ctx, key, count, shown.hidden, "first"), "first");
  const error = tool.status === "error" && tool.resultText ? `<pre class="agent-tool-error-output">${escapeHtml(trimResult(tool))}</pre>` : "";
  return `<div class="agent-tool-detail">${fullscreenSourceRegion(path || "WRITE", preview, codeBlockHtml(content, path))}${error}</div>`;
}

function editHunksForDisplay(tool: ToolView, contextual: boolean): DiffDisplayLine[][] {
  const details = toolDetails(tool);
  const patch = details?.patch ? parseUnifiedPatchHunks(details.patch) : [];
  if (patch.length) return patch;
  const contextLines = contextual ? 3 : Number.POSITIVE_INFINITY;
  return getEditOperations(toolArgs(tool)).map((operation) => contextualDiffLines(operation, contextLines));
}

function highlightedEditHtml(tool: ToolView, contextual: boolean): string {
  const path = stringArg(toolArgs(tool), "path", "file_path");
  return editHunksForDisplay(tool, contextual).map((hunk) => {
    const groups: DiffDisplayLine[][] = [];
    for (const line of hunk) {
      const group = groups.at(-1);
      if (group?.[0]?.kind === line.kind) group.push(line);
      else groups.push([line]);
    }
    const html = groups.map((group) => {
      const code = group.map((line) => line.text).join("\n");
      return `<pre class="agent-edit-lines ${group[0]!.kind}"><code>${highlightCodeHtmlForPath(code, path).html}</code></pre>`;
    }).join("");
    return `<div class="agent-edit-operation">${html}</div>`;
  }).join("");
}

function renderEditDetail(tool: ToolView): string {
  const preview = highlightedEditHtml(tool, true) || genericParamsHtml(tool);
  const full = highlightedEditHtml(tool, false) || genericParamsHtml(tool);
  const edits = fullscreenSourceRegion("EDIT", `<div class="agent-edit-details">${preview}</div>`, `<div class="agent-edit-details">${full}</div>`);
  const error = tool.status === "error" && tool.resultText ? `<pre class="agent-tool-error-output">${escapeHtml(trimResult(tool))}</pre>` : "";
  return `<div class="agent-tool-detail">${edits}${error}</div>`;
}

function renderGenericDetail(ctx: AgentRenderContext, tool: ToolView): string {
  const html = `${genericParamsHtml(tool)}${genericResultHtml(ctx, tool)}`;
  return `<div class="agent-tool-detail">${detailFullscreen(tool.name, html)}</div>`;
}

function renderToolDetail(ctx: AgentRenderContext, key: string, tool: ToolView, count: number): string {
  if (tool.name === "bash") return renderBashDetail(ctx, key, tool, count);
  if (tool.name === "read") return renderReadDetail(ctx, key, tool, count);
  if (tool.name === "write") return renderWriteDetail(ctx, key, tool, count);
  if (tool.name === "edit") return renderEditDetail(tool);
  if (tool.status === "streaming" && tool.argsStream !== undefined) return `<div class="agent-tool-detail">${codeBlockHtml(tool.argsStream, "arguments.json", "agent-tool-code")}</div>`;
  return renderGenericDetail(ctx, tool);
}

function toolClass(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return `tool-${slug}`;
}

function domIdFragment(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function fullscreenAttributes(title: string, mode: "template" | "media" = "template"): string {
  return ` data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="${mode}" data-atelier-fullscreen-title-value="${escapeHtml(title)}"`;
}

function toolArgs(tool: ToolView): JsonObject | undefined {
  return isJsonObject(tool.args) ? tool.args : undefined;
}

function toolArgument<Schema extends TSchema>(args: JsonObject | undefined, schema: Schema, ...keys: ToolArgumentKey[]): Static<Schema> | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (Value.Check(schema, value)) return value;
  }
  return undefined;
}

function stringArg(args: JsonObject | undefined, ...keys: ToolArgumentKey[]): string | undefined {
  return toolArgument(args, toolStringArgumentSchema, ...keys);
}

function numberArg(args: JsonObject | undefined, key: ToolArgumentKey): number | undefined {
  return toolArgument(args, toolNumberArgumentSchema, key);
}

function formatReadRange(args: JsonObject | undefined): string {
  const offset = numberArg(args, "offset");
  const limit = numberArg(args, "limit");
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return `:${start}${end !== undefined ? `-${end}` : ""}`;
}

function pathSummary(tool: ToolView, range = ""): string {
  const args = toolArgs(tool);
  const path = stringArg(args, "path", "file_path");
  return path ? `${path}${range}` : "";
}

function truncateOneLine(text: string, limit: number): string {
  const oneLine = text.replaceAll("\n", " ");
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function trimResult(tool: ToolView): string {
  return (tool.resultText ?? "").trimEnd();
}

function codeBlockHtml(code: string, filePath: string | undefined, className = "agent-tool-code"): string {
  const highlighted = highlightCodeHtmlForPath(code, filePath);
  const languageClass = highlighted.language ? ` language-${escapeHtml(highlighted.language)}` : "";
  return `<pre class="${className}${languageClass}"><code>${highlighted.html}</code></pre>`;
}

function resultPreHtml(text: string, className = "agent-tool-result"): string {
  return text ? `<pre class="${className}">${escapeHtml(text)}</pre>` : "";
}

function toolResultImagesHtml(ctx: AgentRenderContext, tool: ToolView): string {
  const images = tool.resultImages ?? [];
  if (images.length === 0) return "";
  const baseTitle = pathSummary(tool) || "image";
  return `<div class="agent-tool-images">${images.map((image, index) => {
    const title = images.length === 1 ? baseTitle : `${baseTitle} ${index + 1}`;
    return `<img class="agent-media-img agent-tool-image"${fullscreenAttributes(title, "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="${escapeHtml(title)}" loading="lazy">`;
  }).join("")}</div>`;
}

// Keep completed Bash output aligned with the same theme palette as its live xterm.
const ansi16 = [
  "var(--panel)", "var(--red)", "var(--green)", "var(--amber)", "var(--accent)", "var(--violet)", "var(--accent)", "var(--text)",
  "var(--line-2)", "var(--red)", "var(--green)", "var(--amber)", "var(--accent)", "var(--violet)", "var(--accent)", "var(--text)",
];

function ansi256(index: number): string | undefined {
  if (index >= 0 && index < 16) return ansi16[index];
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const level = (v: number) => v === 0 ? 0 : 55 + v * 40;
    return `rgb(${level(r)},${level(g)},${level(b)})`;
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  return undefined;
}

interface AnsiStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fg?: string;
  bg?: string;
}

function styleAttr(style: AnsiStyle): string {
  const rules: string[] = [];
  if (style.bold) rules.push("font-weight:700");
  if (style.italic) rules.push("font-style:italic");
  if (style.underline) rules.push("text-decoration:underline");
  if (style.fg) rules.push(`color:${style.fg}`);
  if (style.bg) rules.push(`background-color:${style.bg}`);
  return rules.length ? ` style="${escapeHtml(rules.join(";"))}"` : "";
}

function ansiToHtml(text: string): string {
  let html = "";
  let style: AnsiStyle = {};
  let open = false;
  const close = () => {
    if (open) html += "</span>";
    open = false;
  };
  const openSpan = () => {
    const attr = styleAttr(style);
    if (attr) {
      html += `<span${attr}>`;
      open = true;
    }
  };
  const setStyle = (next: typeof style) => {
    close();
    style = next;
    openSpan();
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === "\x1b" && text[i + 1] === "]") {
      const rest = text.slice(i + 2);
      const bel = rest.indexOf("\x07");
      const st = rest.indexOf("\x1b\\");
      const end = bel >= 0 && (st < 0 || bel < st) ? bel + 3 : st >= 0 ? st + 4 : -1;
      if (end >= 0) {
        i += end;
        continue;
      }
    }
    if (text[i] === "\x1b" && /[=>78]/.test(text[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.slice(i + 2).search(/[A-Za-z]/);
      if (end >= 0) {
        const final = text[i + 2 + end];
        const raw = text.slice(i + 2, i + 2 + end);
        i += end + 3;
        if (final !== "m") continue;
        const codes = raw === "" ? [0] : raw.split(";").map((part) => part === "" ? 0 : Number(part));
        let next = { ...style };
        for (let c = 0; c < codes.length; c++) {
          const code = Number.isFinite(codes[c]) ? codes[c] : 0;
          if (code === 0) next = {};
          else if (code === 1) next.bold = true;
          else if (code === 3) next.italic = true;
          else if (code === 4) next.underline = true;
          else if (code === 22) next.bold = false;
          else if (code === 23) next.italic = false;
          else if (code === 24) next.underline = false;
          else if (code === 39) next.fg = undefined;
          else if (code === 49) next.bg = undefined;
          else if (code >= 30 && code <= 37) next.fg = ansi16[code - 30];
          else if (code >= 90 && code <= 97) next.fg = ansi16[8 + code - 90];
          else if (code >= 40 && code <= 47) next.bg = ansi16[code - 40];
          else if (code >= 100 && code <= 107) next.bg = ansi16[8 + code - 100];
          else if ((code === 38 || code === 48) && codes[c + 1] === 5) {
            const color = ansi256(codes[c + 2]);
            if (color && code === 38) next.fg = color;
            if (color && code === 48) next.bg = color;
            c += 2;
          } else if ((code === 38 || code === 48) && codes[c + 1] === 2) {
            const r = codes[c + 2], g = codes[c + 3], b = codes[c + 4];
            if ([r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
              const color = `rgb(${r},${g},${b})`;
              if (code === 38) next.fg = color;
              else next.bg = color;
            }
            c += 4;
          }
        }
        setStyle(next);
        continue;
      }
    }
    // Drop non-SGR terminal controls but keep newlines/tabs printable.
    if (text.charCodeAt(i) < 32 && text[i] !== "\n" && text[i] !== "\t") {
      i++;
      continue;
    }
    html += escapeHtml(text[i]);
    i++;
  }
  close();
  return html;
}

function toolDetails(tool: ToolView): ToolViewDetails | undefined {
  return tool.details;
}

function hasAnsiSgr(text: string): boolean {
  return /\x1b\[[0-9;?]*m/.test(text);
}

function colorizePlainBuildOutput(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => {
    const cmake = line.match(/^(\[\s*\d+%\])(\s*)((?:Built|Building|Linking|Generating|Scanning|Consolidate)\b[^:]*)(.*)$/);
    if (cmake) {
      return `<span style="color:var(--accent)">${escapeHtml(cmake[1])}</span>${escapeHtml(cmake[2])}<span style="color:var(--green)">${escapeHtml(cmake[3])}</span>${escapeHtml(cmake[4])}`;
    }
    const diagnostic = line.match(/^(.*?)(warning|error|fatal error|failed|FAILED)(:?.*)$/i);
    if (diagnostic) {
      const color = /warn/i.test(diagnostic[2]) ? "var(--amber)" : "var(--red)";
      return `${escapeHtml(diagnostic[1])}<span style="color:${color};font-weight:700">${escapeHtml(diagnostic[2])}</span>${escapeHtml(diagnostic[3])}`;
    }
    return escapeHtml(line);
  }).join("\n");
}

function bashOutputHtml(text: string): string {
  if (hasAnsiSgr(text)) return ansiToHtml(text);
  return colorizePlainBuildOutput(text);
}

function getEditOperations(args: JsonObject | undefined): DiffOperation[] {
  if (Array.isArray(args?.edits)) {
    return args.edits.flatMap((edit) => Value.Check(diffOperationSchema, edit) ? [edit] : []);
  }
  const oldText = stringArg(args, "oldText");
  const newText = stringArg(args, "newText");
  return oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [];
}

function genericToolSummary(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const direct = stringArg(args, "command", "path", "file_path");
  if (direct) return truncateOneLine(direct, 120);
  const json = JSON.stringify(args);
  return json && json !== "{}" ? truncateOneLine(json, 120) : "";
}

function genericParamsHtml(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const values = Object.values(args);
  if (values.length === 0) return "";
  if (values.length === 1 && genericToolSummary(tool) === values[0]) return "";
  return codeBlockHtml(JSON.stringify(args, null, 2), "arguments.json", "agent-tool-code");
}

function genericResultHtml(ctx: AgentRenderContext, tool: ToolView): string {
  const result = trimResult(tool);
  const images = toolResultImagesHtml(ctx, tool);
  return `${resultPreHtml(result)}${images}`;
}

function partialStringField(stream: string, key: string): string | undefined {
  const marker = new RegExp(`"${key}"\\s*:\\s*"`).exec(stream);
  if (!marker) return undefined;
  const start = marker.index + marker[0].length;
  let escaped = false;
  let raw = "";
  for (let index = start; index < stream.length; index++) {
    const char = stream[index]!;
    if (!escaped && char === '"') break;
    raw += char;
    if (escaped) escaped = false;
    else if (char === "\\\\") escaped = true;
  }
  if (raw.endsWith("\\\\")) raw = raw.slice(0, -1);
  try {
    // SAFETY: Wrapping raw in JSON string quotes makes a successful parse a string.
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw.replaceAll("\\n", "\n").replaceAll('\\"', '"');
  }
}

type StreamedToolArgs = JsonValue | { command: string } | { path?: string; content?: string };

function parseKnownStreamedArgs(name: string, stream: string): StreamedToolArgs | undefined {
  const parsed = parseStreamedArgs(stream);
  if (parsed) return parsed;
  if (name === "bash") return { command: partialStringField(stream, "command") ?? "" };
  if (name === "write") return { path: partialStringField(stream, "path"), content: partialStringField(stream, "content") ?? "" };
  if (name === "read" || name === "edit") return { path: partialStringField(stream, "path") };
  return undefined;
}

function parseStreamedArgs(argsStream: string): JsonValue | undefined {
  if (!argsStream.trim()) return undefined;
  try {
    // SAFETY: JSON.parse returns only values representable by the recursive JsonValue contract.
    return JSON.parse(argsStream) as JsonValue;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Attachments / notices / rewind dialog
// ---------------------------------------------------------------------------

export function renderAttachmentChip(ctx: AgentRenderContext | undefined, attachment: { id: string; name: string; size: number; isImage: boolean }, options: { draftId?: string } = {}): string {
  const chipId = ctx ? ids.chip(ctx, attachment.id) : ids.draftChip(options.draftId ?? "draft", attachment.id);
  return `<span class="agent-chip" id="${chipId}">
    <input type="hidden" name="attachment" value="${escapeHtml(attachment.id)}">
    <span class="agent-chip-ico">${attachment.isImage ? "🖼" : "📄"}</span>
    <span class="agent-chip-name">${escapeHtml(attachment.name)}</span>
    <span class="agent-chip-size">${formatBytes(attachment.size)}</span>
    <button type="button" class="agent-chip-x" data-action="agent-attachments#remove" data-attachment-id="${escapeHtml(attachment.id)}" data-chip-id="${chipId}">✕</button>
  </span>`;
}

export function renderNotice(level: "info" | "error", message: string): string {
  return `<div class="agent-noticeline ${escapeHtml(level)}" data-controller="agent-notice">${escapeHtml(message)}</div>`;
}

function renderRewindDialog(ctx: AgentRenderContext): string {
  return `<dialog class="agent-rewind-dialog" data-agent-pane-target="rewindDialog">
    <form method="post" action="${escapeHtml(agentPath(ctx, "/rewind"))}" data-action="turbo:submit-start->agent-pane#rewindSubmitted">
      <h2>⟲ Rewind conversation</h2>
      <p class="agent-rewind-sub">Everything from <b data-agent-pane-target="rewindPreview"></b> onward is removed from the visible branch. Files in the workspace are not changed.</p>
      <input type="hidden" name="entry" value="" data-agent-pane-target="rewindEntry">
      <label class="agent-rewind-opt"><input type="radio" name="rewindMode" value="discard" checked> <span><span class="t">Discard the tail</span><span class="d">Just go back. The branch stays in the session file.</span></span></label>
      <label class="agent-rewind-opt"><input type="radio" name="rewindMode" value="summary"> <span><span class="t">Replace with an AI summary</span><span class="d">A generated summary of the discarded turns is kept as context.</span><textarea name="customInstructions" rows="2" placeholder="Optional custom summarization instructions go here..." data-action="focus->agent-pane#rewindPickOption"></textarea></span></label>
      <div class="agent-rewind-actions">
        <button class="agent-btn" type="button" data-action="agent-pane#closeRewind">Cancel</button>
        <button class="agent-btn primary" type="submit">Rewind</button>
      </div>
    </form>
  </dialog>`;
}

function formatBytes(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)} MB`;
  if (size >= 1000) return `${Math.round(size / 1000)} KB`;
  return `${size} B`;
}
