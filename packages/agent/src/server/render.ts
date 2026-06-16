import { randomUUID } from "node:crypto";
import { configuredAgentModels } from "@atelier/pi-config/server";
import { diffStats, renderDiffHtml, type DiffOperation } from "./diff.ts";
import { highlightCodeHtmlForPath } from "./highlight.ts";
import { domId, escapeHtml } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { rewriteSegment } from "./rewrite.ts";
import type { WorkspaceAgentInfo } from "./session-store.ts";
import {
  formatCost,
  formatTokens,
  type SectionItem,
  type SectionView,
  type ToolView,
} from "./transcript.ts";

export interface AgentRenderContext {
  workspaceId: string;
  label: string;
}

export function agentTabKey(label: string): string {
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
  section: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_s`, sid),
  activity: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_act`, sid),
  activityBody: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_actbody`, sid),
  final: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_final`, sid),
  item: (ctx: AgentRenderContext, sid: string, n: number) => domId(`${prefix(ctx)}_item`, sid, String(n)),
  itemText: (ctx: AgentRenderContext, sid: string, n: number) => domId(`${prefix(ctx)}_itemtext`, sid, String(n)),
  stats: (ctx: AgentRenderContext) => `${prefix(ctx)}_stats`,
  actions: (ctx: AgentRenderContext) => `${prefix(ctx)}_actions`,
  abortForm: (ctx: AgentRenderContext) => `${prefix(ctx)}_abort_form`,
  attachRow: (ctx: AgentRenderContext) => `${prefix(ctx)}_attach`,
  chip: (ctx: AgentRenderContext, attachmentId: string) => domId(`${prefix(ctx)}_chip`, attachmentId),
  draftAttachRow: (draftId: string) => domId("agent_draft_attach", draftId),
  draftChip: (draftId: string, attachmentId: string) => domId("agent_draft_chip", draftId, attachmentId),
  notices: (ctx: AgentRenderContext) => `${prefix(ctx)}_notices`,
  pendingFollowups: (ctx: AgentRenderContext) => `${prefix(ctx)}_pending_followups`,
};

function agentPath(ctx: AgentRenderContext, suffix: string): string {
  return `/workspaces/${encodeURIComponent(ctx.workspaceId)}/agents/${encodeURIComponent(ctx.label)}${suffix}`;
}

function markdown(ctx: AgentRenderContext, text: string, options: { highlightCode?: boolean } = {}): string {
  return renderMarkdown(text, { rewriteSegment: (segment) => rewriteSegment(ctx.workspaceId, segment), highlightCode: options.highlightCode });
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

export interface AgentModelOption {
  provider: string;
  id: string;
  name: string;
  selected: boolean;
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
  models: AgentModelOption[];
}

export interface AgentPaneState {
  transcriptHtml: string;
  busy: boolean;
  stats: AgentStatsView;
}

export function renderAgentPane(ctx: AgentRenderContext, agent: WorkspaceAgentInfo, state: AgentPaneState, options: { active?: boolean } = {}): string {
  const key = agentTabKey(agent.label);
  const draftId = randomUUID();
  const attachRowId = ids.attachRow(ctx);
  return `<section id="${domId("agent_pane", ctx.workspaceId, agent.label)}" class="tab-pane agent-tab-pane ${options.active ? "active" : ""}" data-tab-pane="${escapeHtml(key)}">
    <div class="agent-pane" id="${ids.pane(ctx)}"
      data-controller="agent-pane agent-attachments"
      data-agent-pane-workspace-id-value="${escapeHtml(ctx.workspaceId)}"
      data-agent-pane-label-value="${escapeHtml(ctx.label)}"
      data-agent-attachments-upload-url-value="${escapeHtml(`/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(attachRowId)}`)}"
      data-action="dragover->agent-attachments#dragOver dragleave->agent-attachments#dragLeave drop->agent-attachments#drop">
      <div class="agent-transcript" id="${ids.transcript(ctx)}" data-agent-pane-target="transcript">${state.transcriptHtml}</div>
      <div class="agent-pending-followups" id="${ids.pendingFollowups(ctx)}" data-agent-pane-target="pendingFollowups">${renderPendingFollowups(ctx, [])}</div>
      ${renderAgentComposer({
        ctx,
        action: agentPath(ctx, "/messages"),
        draftId,
        placeholder: `Message ${ctx.label}… (drop files anywhere)`,
        formTarget: true,
        includePaneActions: true,
        busy: state.busy,
        stats: state.stats,
      })}
      ${renderRewindDialog(ctx)}
    </div>
  </section>`;
}

export interface AgentComposerRenderOptions {
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
  selectedModel?: string;
}

export function renderAgentComposer(options: AgentComposerRenderOptions): string {
  const draftId = options.draftId;
  const attachRowId = options.ctx ? ids.attachRow(options.ctx) : ids.draftAttachRow(draftId);
  const uploadUrl = `/agent-attachment-drafts/${encodeURIComponent(draftId)}/attachments?row=${encodeURIComponent(attachRowId)}`;
  const actionAttrs = ["turbo:submit-end->agent-pane#submitted", "click->agent-pane#focusInput"];
  const targetAttrs = options.formTarget ? ` data-agent-pane-target="form"` : "";
  const inputTarget = options.formTarget ? ` data-agent-pane-target="input"` : "";
  const inputActions = options.formTarget ? ` data-action="keydown->agent-pane#inputKeydown input->agent-pane#autosize"` : "";
  const shortcut = options.submitShortcut ? ` <kbd>${escapeHtml(options.submitShortcut)}</kbd>` : "";
  const actions = options.includePaneActions && options.ctx
    ? `<span id="${ids.actions(options.ctx)}">${renderPromptActions(options.ctx, Boolean(options.busy))}</span>`
    : `<button class="agent-btn primary" type="submit" name="mode" value="send">${escapeHtml(options.submitLabel ?? "Send")}${shortcut}</button>`;
  const formId = options.formId ?? `agent_composer_${draftId}`;
  const statbar = options.stats && options.ctx
    ? `<div class="agent-statbar" id="${ids.stats(options.ctx)}">${renderStatsBar(options.ctx, options.stats)}</div>`
    : `<div class="agent-statbar">${renderComposerSettings(formId, options.selectedModel)}</div>`;
  return `<div class="agent-promptwrap">
        <div class="agent-promptbox" data-controller="agent-attachments" data-agent-attachments-upload-url-value="${escapeHtml(uploadUrl)}" data-action="dragover->agent-attachments#dragOver dragleave->agent-attachments#dragLeave drop->agent-attachments#drop">
          <form id="${escapeHtml(formId)}" method="post" action="${escapeHtml(options.action)}"${targetAttrs}${options.formTarget ? ` data-action="${actionAttrs.join(" ")}"` : options.formActions ? ` data-action="${escapeHtml(options.formActions)}"` : ""}>
            <input type="hidden" name="attachmentDraft" value="${escapeHtml(draftId)}">
            <div class="agent-attach-row" id="${attachRowId}" data-agent-attachments-target="row"></div>
            <textarea class="agent-input" name="text" rows="${options.rows ?? 1}" placeholder="${escapeHtml(options.placeholder)}"${inputTarget}${inputActions}>${escapeHtml(options.initialText ?? "")}</textarea>
            <div class="agent-prompt-actions">
              <span class="agent-drop-hint" data-agent-attachments-target="hint">Drop files to attach</span>
              <span class="spacer"></span>
              ${actions}
            </div>
          </form>
          ${options.includePaneActions && options.ctx ? `<form id="${ids.abortForm(options.ctx)}" method="post" action="${escapeHtml(agentPath(options.ctx, "/abort"))}" hidden></form>` : ""}
          ${statbar}
        </div>
      </div>`;
}

function renderComposerSettings(formId: string, selectedModel?: string): string {
  const selected = configuredAgentModels.some((model) => `${model.provider}::${model.id}` === selectedModel) ? selectedModel : undefined;
  const modelOptions = configuredAgentModels.map((model, index) => {
    const value = `${model.provider}::${model.id}`;
    return `<option value="${escapeHtml(value)}"${(selected ? value === selected : index === 0) ? " selected" : ""}>${escapeHtml(model.label)}</option>`;
  }).join("");
  const thinkingLevels = ["off", "low", "medium", "high"];
  return `<span class="agent-stat-right">
<select class="agent-sel" name="model" form="${escapeHtml(formId)}" title="Model">${modelOptions}</select>
<select class="agent-sel" name="level" form="${escapeHtml(formId)}" title="Thinking level">${thinkingLevels.map((level) => `<option value="${escapeHtml(level)}">${escapeHtml(level)}</option>`).join("")}</select>
</span>`;
}

export function renderPendingFollowups(ctx: AgentRenderContext, messages: Array<{ id: string; displayText: string }>): string {
  return messages.map((message) => `<div class="agent-pending-followup"><form method="post" action="${escapeHtml(agentPath(ctx, `/followups/${encodeURIComponent(message.id)}/cancel`))}"><button class="agent-pending-x" type="submit" title="Cancel follow-up" aria-label="Cancel follow-up">×</button></form><span class="agent-pending-label">Queued follow-up</span><div class="agent-pending-text">${escapeHtml(message.displayText)}</div></div>`).join("");
}

export function renderPromptActions(ctx: AgentRenderContext, busy: boolean): string {
  if (!busy) {
    return `<button class="agent-btn primary" type="submit" name="mode" value="send">Send <kbd>⌘↩</kbd></button>`;
  }
  return `<button class="agent-btn stop" type="submit" form="${ids.abortForm(ctx)}" title="Stop the agent"><span class="agent-stop-dot"></span> Stop</button>
<button class="agent-btn steer" type="submit" name="mode" value="steer" title="Deliver between turns, while the agent keeps working">Steer</button>
<button class="agent-btn primary" type="submit" name="mode" value="followup" title="Deliver after the agent finishes">Follow-up <kbd>⌘↩</kbd></button>`;
}

export function renderStatsBar(ctx: AgentRenderContext, stats: AgentStatsView): string {
  const percent = stats.contextPercent;
  const meter = percent === null
    ? ""
    : `<span class="agent-stat" title="Context window used"><span class="agent-ctx-meter"><i style="width:${Math.min(100, Math.max(0, percent)).toFixed(0)}%"></i></span><b>${percent.toFixed(0)}%</b></span>`;
  const modelOptions = stats.models.map((model) =>
    `<option value="${escapeHtml(`${model.provider}::${model.id}`)}"${model.selected ? " selected" : ""}>${escapeHtml(model.name)}</option>`).join("");
  const thinkingOptions = stats.thinkingLevels.map((level) =>
    `<option value="${escapeHtml(level)}"${level === stats.thinkingLevel ? " selected" : ""}>${escapeHtml(level)}</option>`).join("");
  return `${meter}
<span class="agent-stat" title="Tokens up (input)">↑ <b>${formatTokens(stats.inputTokens)}</b></span>
<span class="agent-stat" title="Tokens down (output)">↓ <b>${formatTokens(stats.outputTokens)}</b></span>
<span class="agent-stat" title="Session cost"><b>${formatCost(stats.cost)}</b></span>
<span class="agent-stat-right">
<form method="post" action="${escapeHtml(agentPath(ctx, "/model"))}" data-controller="agent-autosubmit"><select class="agent-sel" name="model" data-action="change->agent-autosubmit#submit" title="Model">${modelOptions || `<option>${escapeHtml(stats.modelName ?? "no model")}</option>`}</select></form>
${stats.thinkingLevels.length > 0 ? `<form method="post" action="${escapeHtml(agentPath(ctx, "/thinking"))}" data-controller="agent-autosubmit"><select class="agent-sel" name="level" data-action="change->agent-autosubmit#submit" title="Thinking level">${thinkingOptions}</select></form>` : ""}
</span>`;
}

// ---------------------------------------------------------------------------
// Transcript / sections
// ---------------------------------------------------------------------------

export function renderTranscript(ctx: AgentRenderContext, sections: SectionView[], systemPrompt?: string): string {
  const userSections = sections.filter((section) => section.user && section.summaryNote === undefined);
  const latestUserSid = userSections[userSections.length - 1]?.sid;
  return `${renderSystemPromptCard(ctx, systemPrompt)}<div class="agent-notices" id="${ids.notices(ctx)}"></div>${sections.map((section) => renderSection(ctx, section, { collapsed: Boolean(section.user) && section.sid !== latestUserSid })).join("")}`;
}

export function renderSystemPromptCard(ctx: AgentRenderContext, systemPrompt?: string): string {
  const prompt = systemPrompt?.trim();
  if (!prompt) return "";
  return `<details class="agent-tool done tool-system-prompt" id="${ids.systemPrompt(ctx)}">
    <summary class="agent-tool-head"><code class="agent-tool-name">system prompt</code></summary>
    <div class="agent-tool-detail flush"><pre class="agent-tool-code agent-system-prompt-body">${escapeHtml(prompt)}</pre></div>
  </details>`;
}

export function renderSection(ctx: AgentRenderContext, section: SectionView, options: { collapsed?: boolean } = {}): string {
  if (section.summaryNote !== undefined) {
    return `<div class="agent-section agent-summary-section" id="${ids.section(ctx, section.sid)}" data-sid="${escapeHtml(section.sid)}">
      <div class="agent-note summary">${markdown(ctx, section.summaryNote)}</div>
    </div>`;
  }
  const hasActivity = section.items.length > 0 || section.streaming;
  const collapsed = Boolean(options.collapsed) && !section.streaming;
  return `<div class="agent-section${section.streaming ? " streaming" : ""}${collapsed ? " collapsed" : ""}" id="${ids.section(ctx, section.sid)}" data-sid="${escapeHtml(section.sid)}">
    ${section.userEntryId ? renderRewindZone(ctx, section) : ""}
    ${section.user ? renderUserMessage(ctx, section.user) : ""}
    <div class="agent-activity" id="${ids.activity(ctx, section.sid)}"${hasActivity ? "" : " hidden"}>
      <div class="agent-actbody" id="${ids.activityBody(ctx, section.sid)}">${section.items.map((item, index) => renderItem(ctx, section.sid, index, item, { live: section.streaming && index === section.items.length - 1, collapsed })).join("")}</div>
    </div>
    <div class="agent-final" id="${ids.final(ctx, section.sid)}">${section.finalText ? renderFinalText(ctx, section.finalText) : ""}</div>
    ${section.errorMessage ? `<div class="agent-error">${escapeHtml(section.errorMessage)}</div>` : ""}
  </div>`;
}


function renderRewindZone(ctx: AgentRenderContext, section: SectionView): string {
  if (!section.userEntryId) return "";
  return `<div class="agent-rewind-zone"><button class="agent-rewind-btn" type="button"
    data-action="agent-pane#openRewind"
    data-entry-id="${escapeHtml(section.userEntryId)}"
    data-user-text="${escapeHtml(section.user?.text ?? "")}">⟲ Rewind to here</button></div>`;
}

export function renderUserMessage(ctx: AgentRenderContext, user: { text: string; images: { mimeType: string; data: string }[] }): string {
  const images = user.images.length > 0
    ? `<div class="agent-user-attachments">${user.images.map((image) => `<img src="data:${escapeHtml(image.mimeType)};base64,${escapeHtml(image.data)}" alt="attachment">`).join("")}</div>`
    : "";
  return `<div class="agent-user"><div class="agent-user-bubble">${markdown(ctx, user.text)}${images}</div></div>`;
}

export function renderFinalText(ctx: AgentRenderContext, text: string, options: { highlightCode?: boolean } = {}): string {
  return `<div class="agent-md">${markdown(ctx, text, { highlightCode: options.highlightCode })}</div>`;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function renderItem(ctx: AgentRenderContext, sid: string, index: number, item: SectionItem, options: { live?: boolean; collapsed?: boolean } = {}): string {
  const id = ids.item(ctx, sid, index);
  if (item.type === "thinking") {
    return `<div class="agent-item agent-thinking" id="${id}"><div class="agent-thinking-text" id="${ids.itemText(ctx, sid, index)}">${escapeHtml(item.text)}</div></div>`;
  }
  if (item.type === "text") {
    if (options.live) {
      return `<div class="agent-item agent-itext" id="${id}"><div class="agent-stream-text" id="${ids.itemText(ctx, sid, index)}">${escapeHtml(item.text)}</div></div>`;
    }
    return `<div class="agent-item agent-itext" id="${id}"><div class="agent-md">${markdown(ctx, item.text)}</div></div>`;
  }
  if (item.type === "note") {
    return `<div class="agent-item agent-note ${escapeHtml(item.tone)}" id="${id}">${markdown(ctx, item.text)}</div>`;
  }
  if (item.tool.status === "streaming") {
    return renderStreamingToolItem(ctx, sid, index, item.tool.name, item.tool.argsStream ?? "");
  }
  return `<div class="agent-item" id="${id}">${renderToolCard(ctx, item.tool, { open: !options.collapsed })}</div>`;
}

/** Streaming placeholders used by the live pipeline (content streamed into the text target). */
export function renderStreamingThinkingItem(ctx: AgentRenderContext, sid: string, index: number): string {
  return `<div class="agent-item agent-thinking" id="${ids.item(ctx, sid, index)}"><div class="agent-thinking-text" id="${ids.itemText(ctx, sid, index)}"></div></div>`;
}

export function renderStreamingToolItem(ctx: AgentRenderContext, sid: string, index: number, name: string, argsStream = ""): string {
  const parsed = parseStreamedArgs(argsStream);
  const tool: ToolView = { callId: "streaming", name, args: parsed, status: "streaming", argsStream };
  const renderer = toolRenderer(tool.name);
  const summary = renderer.summary?.(tool) ?? genericToolSummary(tool);
  const knownBody = parsed ? renderer.paramsHtml?.(ctx, tool) : "";
  const streamTarget = ids.itemText(ctx, sid, index);
  const stream = renderer.known
    ? `${knownBody ? `<div class="agent-tool-detail">${knownBody}</div>` : `<div class="agent-tool-empty agent-tool-stream">composing arguments…</div>`}<span id="${streamTarget}" hidden></span>`
    : `<pre class="agent-tool-stream" id="${streamTarget}">${escapeHtml(argsStream)}</pre>`;
  return `<div class="agent-item" id="${ids.item(ctx, sid, index)}"><div class="agent-tool streaming ${toolClass(name)}">
    <div class="agent-tool-head"><span class="agent-tool-glyph pending">…</span><code class="agent-tool-name">${escapeHtml(name || "tool")}</code><span class="agent-tool-args">${escapeHtml(summary || "composing…")}</span></div>
    ${stream}
  </div></div>`;
}

export function renderRunningToolCard(ctx: AgentRenderContext, tool: ToolView): string {
  const renderer = toolRenderer(tool.name);
  const argsSummary = renderer.summary?.(tool) ?? genericToolSummary(tool);
  const showTerminal = tool.name === "bash" && Boolean(tool.tmuxSession && tool.terminalVisible);
  const terminal = showTerminal
    ? `<div class="agent-tool-term observable-terminal-host" data-controller="agent-term"
        data-agent-term-workspace-id-value="${escapeHtml(ctx.workspaceId)}"
        data-agent-term-label-value="${escapeHtml(ctx.label)}"
        data-agent-term-session-value="${escapeHtml(tool.tmuxSession!)}"></div>`
    : tool.resultText
      ? `<pre class="agent-tool-stream agent-tool-livestream">${escapeHtml(tool.resultText)}</pre>`
      : renderer.paramsHtml?.(ctx, tool) ?? "";
  const elapsed = tool.startedAt
    ? `<span class="agent-tool-elapsed" data-controller="agent-elapsed" data-agent-elapsed-since-value="${tool.startedAt}"${tool.timeoutSeconds ? ` data-agent-elapsed-max-value="${tool.timeoutSeconds}"` : ""}><span data-agent-elapsed-target="time">0s</span></span>`
    : "";
  return `<div class="agent-tool running ${toolClass(tool.name)}">
    <div class="agent-tool-head"><span class="agent-tool-glyph pending">…</span><code class="agent-tool-name">${escapeHtml(tool.name)}</code><span class="agent-tool-args">${escapeHtml(argsSummary)}</span>${elapsed}</div>
    ${terminal}
  </div>`;
}

const toolResultPreviewLimit = 4000;

export function renderToolCard(ctx: AgentRenderContext, tool: ToolView, options: { open?: boolean } = {}): string {
  if (tool.status === "running") return renderRunningToolCard(ctx, tool);
  const glyph = tool.status === "error" ? `<span class="agent-tool-glyph err">✕</span>` : `<span class="agent-tool-glyph ok">✓</span>`;
  const renderer = toolRenderer(tool.name);
  const argsSummary = renderer.summary?.(tool) ?? genericToolSummary(tool);
  const paramsHtml = renderer.known ? (renderer.paramsHtml?.(ctx, tool) ?? "") : genericParamsHtml(tool);
  const resultHtml = renderer.resultHtml?.(ctx, tool) ?? genericResultHtml(tool);
  const emptyResultHtml = renderer.hideEmptyResult ? "" : `<div class="agent-tool-empty">no output</div>`;
  const bodyHtml = `${paramsHtml}${resultHtml || emptyResultHtml}`;
  const flushSingleBlock = Boolean(renderer.flushSingleBlock && ((paramsHtml && !resultHtml) || (!paramsHtml && resultHtml)));
  return `<details class="agent-tool done ${toolClass(tool.name)}${tool.status === "error" ? " error" : ""}"${options.open ? " open" : ""}>
    <summary class="agent-tool-head">${glyph}<code class="agent-tool-name">${escapeHtml(tool.name)}</code><span class="agent-tool-args">${escapeHtml(argsSummary)}</span></summary>
    <div class="agent-tool-detail${flushSingleBlock ? " flush" : ""}">${bodyHtml}</div>
  </details>`;
}

function toolClass(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
  return `tool-${slug}`;
}

interface ToolRenderer {
  known?: boolean;
  summary?: (tool: ToolView) => string;
  paramsHtml?: (ctx: AgentRenderContext, tool: ToolView) => string;
  resultHtml?: (ctx: AgentRenderContext, tool: ToolView) => string;
  hideEmptyResult?: boolean;
  flushSingleBlock?: boolean;
}

function toolRenderer(name: string): ToolRenderer {
  if (name === "bash") return bashRenderer;
  if (name === "read") return readRenderer;
  if (name === "write") return writeRenderer;
  if (name === "edit") return editRenderer;
  return {};
}

function toolArgs(tool: ToolView): Record<string, unknown> | undefined {
  return tool.args && typeof tool.args === "object" && !Array.isArray(tool.args) ? tool.args as Record<string, unknown> : undefined;
}

function stringArg(args: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof args?.[key] === "string") return args[key] as string;
  return undefined;
}

function numberArg(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatReadRange(args: Record<string, unknown> | undefined): string {
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

function commandSummary(tool: ToolView): string {
  const command = stringArg(toolArgs(tool), "command");
  return command ? truncateOneLine(command, 120) : "";
}

function truncateOneLine(text: string, limit: number): string {
  const oneLine = text.replaceAll("\n", " ");
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function trimResult(tool: ToolView): string {
  return (tool.resultText ?? "").trimEnd();
}

function limitedText(text: string, options: { lines: number; chars: number }): { text: string; truncated: boolean } {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const byLines = lines.length > options.lines ? lines.slice(0, options.lines).join("\n") : text;
  const byChars = byLines.length > options.chars ? byLines.slice(0, options.chars) : byLines;
  return { text: byChars, truncated: byChars.length < text.length || lines.length > options.lines };
}

function codeBlockHtml(code: string, filePath: string | undefined, className = "agent-tool-code", limit?: { lines: number; chars: number }): string {
  const preview = limit ? limitedText(code, limit) : { text: code, truncated: false };
  const suffix = preview.truncated ? "\n…" : "";
  const highlighted = highlightCodeHtmlForPath(`${preview.text}${suffix}`, filePath);
  const languageClass = highlighted.language ? ` language-${escapeHtml(highlighted.language)}` : "";
  return `<pre class="${className}${languageClass}"><code>${highlighted.html}</code></pre>`;
}

function resultPreHtml(text: string, className = "agent-tool-result"): string {
  return text ? `<pre class="${className}">${escapeHtml(text)}</pre>` : "";
}

const ansi16 = [
  "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
  "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
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

function styleAttr(style: { bold?: boolean; italic?: boolean; underline?: boolean; fg?: string; bg?: string }): string {
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
  let style: { bold?: boolean; italic?: boolean; underline?: boolean; fg?: string; bg?: string } = {};
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
            if ([r, g, b].every((v) => typeof v === "number" && v >= 0 && v <= 255)) {
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

function bashDetails(tool: ToolView): Record<string, unknown> | undefined {
  return tool.details && typeof tool.details === "object" ? tool.details as Record<string, unknown> : undefined;
}

function hasAnsiSgr(text: string): boolean {
  return /\x1b\[[0-9;?]*m/.test(text);
}

function colorizePlainBuildOutput(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => {
    const cmake = line.match(/^(\[\s*\d+%\])(\s*)((?:Built|Building|Linking|Generating|Scanning|Consolidate)\b[^:]*)(.*)$/);
    if (cmake) {
      return `<span style="color:#00cdcd">${escapeHtml(cmake[1])}</span>${escapeHtml(cmake[2])}<span style="color:#00cd00">${escapeHtml(cmake[3])}</span>${escapeHtml(cmake[4])}`;
    }
    const diagnostic = line.match(/^(.*?)(warning|error|fatal error|failed|FAILED)(:?.*)$/i);
    if (diagnostic) {
      const color = /warn/i.test(diagnostic[2]) ? "#cdcd00" : "#ff0000";
      return `${escapeHtml(diagnostic[1])}<span style="color:${color};font-weight:700">${escapeHtml(diagnostic[2])}</span>${escapeHtml(diagnostic[3])}`;
    }
    return escapeHtml(line);
  }).join("\n");
}

function bashOutputHtml(text: string): string {
  if (hasAnsiSgr(text)) return ansiToHtml(text);
  return colorizePlainBuildOutput(text);
}

const bashRenderer: ToolRenderer = {
  known: true,
  flushSingleBlock: true,
  summary: commandSummary,
  resultHtml: (_ctx, tool) => {
    const displayAnsi = bashDetails(tool)?.displayAnsi;
    if (typeof displayAnsi === "string" && displayAnsi.trim()) {
      return `<pre class="agent-tool-result agent-tool-ansi">${bashOutputHtml(displayAnsi)}</pre>`;
    }
    return resultPreHtml(trimResult(tool));
  },
};

const readRenderer: ToolRenderer = {
  known: true,
  flushSingleBlock: true,
  summary: (tool) => pathSummary(tool, formatReadRange(toolArgs(tool))),
  resultHtml: (_ctx, tool) => {
    const result = trimResult(tool);
    if (!result) return "";
    return codeBlockHtml(result, stringArg(toolArgs(tool), "path", "file_path"), "agent-tool-result agent-tool-code");
  },
};

const writeRenderer: ToolRenderer = {
  known: true,
  hideEmptyResult: true,
  flushSingleBlock: true,
  summary: (tool) => pathSummary(tool),
  paramsHtml: (_ctx, tool) => {
    const args = toolArgs(tool);
    const content = stringArg(args, "content");
    if (content === undefined) return genericParamsHtml(tool);
    return codeBlockHtml(content, stringArg(args, "path", "file_path"), "agent-tool-code", { lines: tool.status === "running" ? 80 : 120, chars: tool.status === "running" ? 8000 : 12000 });
  },
  resultHtml: (_ctx, tool) => tool.status === "error" ? resultPreHtml(trimResult(tool)) : "",
};

const editRenderer: ToolRenderer = {
  known: true,
  hideEmptyResult: true,
  flushSingleBlock: true,
  summary: (tool) => {
    const path = pathSummary(tool);
    const operations = getEditOperations(toolArgs(tool));
    const blockCount = operations.length;
    const blocks = blockCount > 0 ? `${blockCount} ${blockCount === 1 ? "block" : "blocks"}` : "";
    const stats = diffStats(operations);
    const lines = stats.added > 0 || stats.deleted > 0 ? `+${stats.added} -${stats.deleted}` : "";
    return [path, blocks, lines].filter(Boolean).join(" · ");
  },
  paramsHtml: (_ctx, tool) => renderDiffHtml(getEditOperations(toolArgs(tool))) || genericParamsHtml(tool),
  resultHtml: (_ctx, tool) => tool.status === "error" ? resultPreHtml(trimResult(tool)) : "",
};

function getEditOperations(args: Record<string, unknown> | undefined): DiffOperation[] {
  if (!args) return [];
  if (Array.isArray(args.edits)) {
    return args.edits.flatMap((edit) => {
      if (!edit || typeof edit !== "object") return [];
      const entry = edit as Record<string, unknown>;
      return typeof entry.oldText === "string" && typeof entry.newText === "string" ? [{ oldText: entry.oldText, newText: entry.newText }] : [];
    });
  }
  return typeof args.oldText === "string" && typeof args.newText === "string" ? [{ oldText: args.oldText, newText: args.newText }] : [];
}

function genericToolSummary(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const direct = stringArg(args, "command", "path", "file_path");
  if (direct) return truncateOneLine(direct, 120);
  const json = JSON.stringify(args);
  return json && json !== "{}" ? truncateOneLine(json, 120) : "";
}

export function toolArgsSummary(tool: ToolView): string {
  const renderer = toolRenderer(tool.name);
  return renderer.summary?.(tool) ?? genericToolSummary(tool);
}

function genericParamsHtml(tool: ToolView): string {
  const args = toolArgs(tool);
  if (!args) return "";
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  if (keys.length === 1 && typeof args[keys[0]] === "string" && genericToolSummary(tool) === args[keys[0]]) return "";
  return `<pre class="agent-tool-params">${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
}

function genericResultHtml(tool: ToolView): string {
  const result = trimResult(tool);
  if (!result) return "";
  const truncated = result.length > toolResultPreviewLimit;
  const shown = truncated ? `${result.slice(0, toolResultPreviewLimit)}\n… (${formatTokens(result.length)} chars total)` : result;
  return resultPreHtml(shown);
}

function parseStreamedArgs(argsStream: string): unknown | undefined {
  if (!argsStream.trim()) return undefined;
  try {
    return JSON.parse(argsStream);
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
      <p class="agent-rewind-sub">Everything from <b data-agent-pane-target="rewindPreview"></b> onward is removed from the active branch. Files in the workspace are not changed.</p>
      <input type="hidden" name="entry" value="" data-agent-pane-target="rewindEntry">
      <label class="agent-rewind-opt"><input type="radio" name="rewindMode" value="discard" checked> <span><span class="t">Discard the tail</span><span class="d">Just go back. The branch stays in the session file.</span></span></label>
      <label class="agent-rewind-opt"><input type="radio" name="rewindMode" value="summary"> <span><span class="t">Replace with an AI summary</span><span class="d">A generated summary of the discarded turns is kept as context.</span></span></label>
      <label class="agent-rewind-opt"><input type="radio" name="rewindMode" value="custom"> <span><span class="t">Replace with custom text</span><span class="d">Write your own note about what happened.</span><textarea name="note" rows="2" placeholder="e.g. We tried X; abandoned because…" data-action="focus->agent-pane#rewindPickCustom"></textarea></span></label>
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
