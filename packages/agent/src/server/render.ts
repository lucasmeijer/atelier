import { randomUUID } from "node:crypto";
import { configuredAgentModels } from "@atelier/pi-config/server";
import { domId, escapeHtml } from "./html.ts";
import { renderMarkdown } from "./markdown.ts";
import { rewriteSegment } from "./rewrite.ts";
import type { WorkspaceAgentInfo } from "./session-store.ts";
import {
  formatCost,
  formatTokens,
  summarizeSectionStats,
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
  section: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_s`, sid),
  activity: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_act`, sid),
  activityBody: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_actbody`, sid),
  activitySummary: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_actsum`, sid),
  activityRow: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_actrow`, sid),
  final: (ctx: AgentRenderContext, sid: string) => domId(`${prefix(ctx)}_final`, sid),
  item: (ctx: AgentRenderContext, sid: string, n: number) => domId(`${prefix(ctx)}_item`, sid, String(n)),
  itemText: (ctx: AgentRenderContext, sid: string, n: number) => domId(`${prefix(ctx)}_itemtext`, sid, String(n)),
  stats: (ctx: AgentRenderContext) => `${prefix(ctx)}_stats`,
  actions: (ctx: AgentRenderContext) => `${prefix(ctx)}_actions`,
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
  return renderMarkdown(text, { rewriteSegment: (segment) => rewriteSegment(ctx.workspaceId, segment) });
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
    : `<div class="agent-statbar">${renderComposerSettings(formId)}</div>`;
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
          ${statbar}
        </div>
      </div>`;
}

function renderComposerSettings(formId: string): string {
  const modelOptions = configuredAgentModels.map((model, index) =>
    `<option value="${escapeHtml(`${model.provider}::${model.id}`)}"${index === 0 ? " selected" : ""}>${escapeHtml(model.label)}</option>`).join("");
  const thinkingLevels = ["off", "low", "medium", "high"];
  return `<span class="agent-stat-right">
<select class="agent-sel" name="model" form="${escapeHtml(formId)}" title="Model">${modelOptions}</select>
<select class="agent-sel" name="level" form="${escapeHtml(formId)}" title="Thinking level">${thinkingLevels.map((level) => `<option value="${escapeHtml(level)}">${escapeHtml(level)}</option>`).join("")}</select>
</span>`;
}

export function renderPromptActions(ctx: AgentRenderContext, busy: boolean): string {
  if (!busy) {
    return `<button class="agent-btn primary" type="submit" name="mode" value="send">Send <kbd>⌘↩</kbd></button>`;
  }
  return `<button class="agent-btn steer" type="submit" name="mode" value="steer" title="Deliver between turns, while the agent keeps working">Steer</button>
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

export function renderTranscript(ctx: AgentRenderContext, sections: SectionView[]): string {
  return `<div class="agent-notices" id="${ids.notices(ctx)}"></div>${sections.map((section) => renderSection(ctx, section)).join("")}`;
}

export function renderSection(ctx: AgentRenderContext, section: SectionView): string {
  if (section.summaryNote !== undefined) {
    return `<div class="agent-section agent-summary-section" id="${ids.section(ctx, section.sid)}" data-sid="${escapeHtml(section.sid)}">
      <div class="agent-note summary">${markdown(ctx, section.summaryNote)}</div>
    </div>`;
  }
  const hasThinking = section.items.some((item) => item.type === "thinking");
  const hasActivity = section.items.length > 0 || section.streaming;
  const summary = section.streaming
    ? renderActivitySummaryStreaming(ctx, section, section.startedAt ?? Date.now())
    : `<button class="agent-actsum" type="button" id="${ids.activitySummary(ctx, section.sid)}" data-action="agent-pane#toggleActivity"><span class="agent-chev">▸</span>${escapeHtml(summarizeSectionStats(section.stats, { hasThinking }))}</button>`;
  return `<div class="agent-section${section.streaming ? " streaming" : ""}" id="${ids.section(ctx, section.sid)}" data-sid="${escapeHtml(section.sid)}">
    ${section.userEntryId ? renderRewindZone(ctx, section) : ""}
    ${section.user ? renderUserMessage(ctx, section.user) : ""}
    <div class="agent-activity" id="${ids.activity(ctx, section.sid)}"${hasActivity ? "" : " hidden"}>
      <div class="agent-actrow" id="${ids.activityRow(ctx, section.sid)}">${summary}</div>
      <div class="agent-actbody" id="${ids.activityBody(ctx, section.sid)}">${section.items.map((item, index) => renderItem(ctx, section.sid, index, item, { live: section.streaming && index === section.items.length - 1 })).join("")}</div>
    </div>
    <div class="agent-final" id="${ids.final(ctx, section.sid)}">${section.finalText ? renderFinalText(ctx, section.finalText) : ""}</div>
    ${section.errorMessage ? `<div class="agent-error">${escapeHtml(section.errorMessage)}</div>` : ""}
  </div>`;
}

export function renderActivitySummaryStreaming(ctx: AgentRenderContext, section: SectionView, startedAt: number): string {
  const hasThinking = section.items.some((item) => item.type === "thinking");
  const label = section.items.length === 0 ? "working" : summarizeSectionStats(section.stats, { hasThinking });
  return `<button class="agent-actsum" type="button" id="${ids.activitySummary(ctx, section.sid)}" data-action="agent-pane#toggleActivity"><span class="agent-chev">▸</span>${escapeHtml(label)}</button>
<form method="post" action="${escapeHtml(agentPath(ctx, "/abort"))}" class="agent-stopform"><button class="agent-stop" type="submit" title="Stop the agent" data-controller="agent-elapsed" data-agent-elapsed-since-value="${startedAt}"><span class="agent-stop-sq"></span><span data-agent-elapsed-target="time">0s</span></button></form>`;
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

export function renderFinalText(ctx: AgentRenderContext, text: string): string {
  return `<div class="agent-md">${markdown(ctx, text)}</div>`;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function renderItem(ctx: AgentRenderContext, sid: string, index: number, item: SectionItem, options: { live?: boolean } = {}): string {
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
  return `<div class="agent-item" id="${id}">${renderToolCard(ctx, item.tool)}</div>`;
}

/** Streaming placeholders used by the live pipeline (content streamed into the text target). */
export function renderStreamingThinkingItem(ctx: AgentRenderContext, sid: string, index: number): string {
  return `<div class="agent-item agent-thinking" id="${ids.item(ctx, sid, index)}"><div class="agent-thinking-text" id="${ids.itemText(ctx, sid, index)}"></div></div>`;
}

export function renderStreamingTextItem(ctx: AgentRenderContext, sid: string, index: number): string {
  return `<div class="agent-item agent-itext" id="${ids.item(ctx, sid, index)}"><div class="agent-stream-text" id="${ids.itemText(ctx, sid, index)}"></div></div>`;
}

export function renderStreamingToolItem(ctx: AgentRenderContext, sid: string, index: number, name: string, argsStream = ""): string {
  return `<div class="agent-item" id="${ids.item(ctx, sid, index)}"><div class="agent-tool streaming">
    <div class="agent-tool-head"><span class="agent-tool-glyph run"></span><code class="agent-tool-name">${escapeHtml(name || "tool")}</code><span class="agent-tool-args">composing…</span></div>
    <pre class="agent-tool-stream" id="${ids.itemText(ctx, sid, index)}">${escapeHtml(argsStream)}</pre>
  </div></div>`;
}

export function renderRunningToolCard(ctx: AgentRenderContext, tool: ToolView): string {
  const argsSummary = toolArgsSummary(tool);
  const showTerminal = Boolean(tool.tmuxSession && tool.terminalVisible);
  const terminal = showTerminal
    ? `<div class="agent-tool-term" data-controller="agent-term"
        data-agent-term-workspace-id-value="${escapeHtml(ctx.workspaceId)}"
        data-agent-term-label-value="${escapeHtml(ctx.label)}"
        data-agent-term-session-value="${escapeHtml(tool.tmuxSession!)}"></div>`
    : tool.resultText
      ? `<pre class="agent-tool-stream agent-tool-livestream">${escapeHtml(tool.resultText)}</pre>`
      : "";
  const elapsed = tool.startedAt
    ? `<form method="post" action="${escapeHtml(agentPath(ctx, "/abort"))}" class="agent-stopform"><button class="agent-stop" type="submit" title="Stop" data-controller="agent-elapsed" data-agent-elapsed-since-value="${tool.startedAt}"${tool.timeoutSeconds ? ` data-agent-elapsed-max-value="${tool.timeoutSeconds}"` : ""}><span class="agent-stop-sq"></span><span data-agent-elapsed-target="time">0s</span></button></form>`
    : "";
  return `<div class="agent-tool running">
    <div class="agent-tool-head"><span class="agent-tool-glyph run"></span><code class="agent-tool-name">${escapeHtml(tool.name)}</code><span class="agent-tool-args">${escapeHtml(argsSummary)}</span>${elapsed}</div>
    ${terminal}
  </div>`;
}

const toolResultPreviewLimit = 4000;

export function renderToolCard(ctx: AgentRenderContext, tool: ToolView): string {
  if (tool.status === "running") return renderRunningToolCard(ctx, tool);
  const glyph = tool.status === "error" ? `<span class="agent-tool-glyph err">✕</span>` : `<span class="agent-tool-glyph ok">✓</span>`;
  const argsSummary = toolArgsSummary(tool);
  const params = toolParamsText(tool);
  const result = (tool.resultText ?? "").trimEnd();
  const truncated = result.length > toolResultPreviewLimit;
  const shown = truncated ? `${result.slice(0, toolResultPreviewLimit)}\n… (${formatTokens(result.length)} chars total)` : result;
  return `<details class="agent-tool done${tool.status === "error" ? " error" : ""}">
    <summary class="agent-tool-head">${glyph}<code class="agent-tool-name">${escapeHtml(tool.name)}</code><span class="agent-tool-args">${escapeHtml(argsSummary)}</span></summary>
    <div class="agent-tool-detail">
      ${params ? `<pre class="agent-tool-params">${escapeHtml(params)}</pre>` : ""}
      ${shown ? `<pre class="agent-tool-result">${escapeHtml(shown)}</pre>` : `<div class="agent-tool-empty">no output</div>`}
    </div>
  </details>`;
}

export function toolArgsSummary(tool: ToolView): string {
  const args = tool.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return "";
  if (typeof args.command === "string") return args.command.length > 120 ? `${args.command.slice(0, 120)}…` : args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.file_path === "string") return args.file_path;
  const json = JSON.stringify(args);
  return json && json !== "{}" ? (json.length > 120 ? `${json.slice(0, 120)}…` : json) : "";
}

function toolParamsText(tool: ToolView): string {
  const args = tool.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return "";
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  // Single string arg that is already shown in the summary: skip params block.
  if (keys.length === 1 && typeof args[keys[0]] === "string" && toolArgsSummary(tool) === args[keys[0]]) return "";
  return JSON.stringify(args, null, 2);
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
