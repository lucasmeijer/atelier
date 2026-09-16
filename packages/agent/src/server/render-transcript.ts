import { renderStreamingMarkdownSnapshot } from "@atelier/markdown";
import { escapeHtml } from "./html.ts";
import { thinkingBlockRendererFor } from "./thinking-block-renderers.ts";
import { formatDuration, formatTokens, type TranscriptItem, type WorkingTranscriptItem } from "./transcript.ts";
import { commentaryContext, ids, sessionImageUrl, transcriptItemPath, type AgentRenderContext } from "./render-context.ts";
import { codeBlockHtml, detailFullscreen, fullscreenAttributes, markdown, renderMarkdownRow, transcriptActionItemHtml, transcriptRow } from "./render-markup.ts";
import { renderToolCard, renderToolDetail } from "./render-tool.ts";

export interface AgentToolDefinitionView {
  name: string;
  description: string;
  parameters: unknown;
  output_schema?: unknown;
}

export interface AgentModelContextView {
  systemPrompt: string;
  tools: AgentToolDefinitionView[];
}

export function renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView): string {
  return `${renderModelContextEntries(ctx, modelContext)}${items.map((item) => renderTranscriptItem(ctx, item)).join("")}<div class="agent-notices" id="${ids.notices(ctx)}"></div>`;
}

function renderModelContextEntries(ctx: AgentRenderContext, modelContext: AgentModelContextView): string {
  const prompt = modelContext.systemPrompt.trim()
    ? renderLazyTranscriptEntry(ctx, "system-prompt", "System prompt") : "";
  const tools = modelContext.tools.length
    ? renderLazyTranscriptEntry(ctx, "tool-definitions", "Tool definitions") : "";
  return `${prompt}${tools}`;
}

function renderLazyTranscriptEntry(ctx: AgentRenderContext, key: string, label: string): string {
  const frame = `<turbo-frame id="${ids.detailFrame(ctx, key)}" data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, key))}"></turbo-frame>`;
  return transcriptRow(`<details class="agent-lazy-detail" data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load">${transcriptActionItemHtml({ kind: "text", text: label }, { disclosure: true })}${frame}</details>`);
}

export function renderModelContextDetailFrame(ctx: AgentRenderContext, modelContext: AgentModelContextView, key: "system-prompt" | "tool-definitions"): string {
  const content = key === "system-prompt"
    ? renderMarkdownRow(ctx, modelContext.systemPrompt, "markdown agent-itext-md")
    : `<div class="agent-tool-detail">${detailFullscreen("Tool definitions", codeBlockHtml(JSON.stringify(modelContext.tools, null, 2), "tools.json"))}</div>`;
  return `<turbo-frame id="${ids.detailFrame(ctx, key)}">${content}</turbo-frame>`;
}

function renderUserMessage(ctx: AgentRenderContext, user: Extract<TranscriptItem, { type: "user" }>): string {
  const images = user.images.length ? `<div class="agent-user-attachments">${user.images.map((image) => `<img${fullscreenAttributes("attachment", "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="attachment" loading="lazy">`).join("")}</div>` : "";
  const label = user.pending ? "Queued · awaiting consumption" : user.steering ? "Steering" : "";
  return transcriptRow(`<div class="agent-user" data-agent-user-text="${escapeHtml(user.text)}"><div class="agent-user-bubble markdown">${label ? `<div class="agent-user-label">${label}</div>` : ""}${markdown(ctx, user.text)}${images}</div></div>`);
}

function renderStreamingTextBody(ctx: AgentRenderContext, key: string, text: string, className: string): string {
  const snapshot = renderStreamingMarkdownSnapshot(ctx.workspaceId, text);
  return `<div class="${className} agent-stream-markdown" data-controller="agent-streaming-text" id="${ids.itemText(ctx, key)}"><div id="${ids.itemTextStable(ctx, key)}">${snapshot.stableHtml}</div><div id="${ids.itemTextTail(ctx, key)}">${snapshot.tailHtml}</div></div>`;
}

export function renderTranscriptItem(ctx: AgentRenderContext, item: TranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  if (item.type === "working") return renderWorkingSection(ctx, item);
  const id = ids.item(ctx, item.key);
  let body = "";
  if (item.type === "inherited-context") {
    const label = `Inherited context from ${item.source} · ${item.messageCount} ${item.messageCount === 1 ? "message" : "messages"} · filtered`;
    body = renderLazyTranscriptEntry(ctx, item.key, label);
  } else if (item.type === "user") body = renderUserMessage(ctx, item);
  else if (item.type === "thinking") body = renderThinkingItem(ctx, item);
  else if (item.type === "text") {
    const className = item.final ? "markdown agent-final" : "markdown agent-itext-md";
    body = item.live
      ? transcriptRow(renderStreamingTextBody(ctx, item.key, item.text, className))
      : renderMarkdownRow(ctx, item.text, className);
  } else if (item.type === "tool") body = transcriptRow(renderToolCard(ctx, item.key, item.tool, { ...options, open: options.open || Boolean(ctx.revealTarget && (item.anchor === ctx.revealTarget || item.key === ctx.revealTarget)) }));
  else if (item.type === "extension") body = item.render(ctx);
  else if (item.type === "note") body = renderMarkdownRow(ctx, item.text, `agent-note ${escapeHtml(item.tone)}`);
  else body = transcriptRow(`<div class="agent-error">${escapeHtml(item.text)}</div>`);
  return `<div class="agent-item" id="${id}" data-transcript-key="${escapeHtml(item.key)}"${item.anchor ? ` data-transcript-anchor="${escapeHtml(item.anchor)}"` : ""}>${body}</div>`;
}

export function renderWorkingContent(ctx: AgentRenderContext, section: WorkingTranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  const content = section.items.map((item) => renderTranscriptItem(ctx, item, options)).join("");
  const finished = section.completedAt !== undefined || section.stoppedAt !== undefined;
  return !content && finished ? '<p class="agent-working-empty">No intermediate activity for this turn.</p>' : content;
}

function renderWorkingItems(ctx: AgentRenderContext, section: WorkingTranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  const items = renderWorkingContent(ctx, section, options);
  return `<div class="agent-working-items" id="${ids.workingItems(ctx, section.key)}">${items}</div>`;
}

function renderWorkingSection(ctx: AgentRenderContext, section: WorkingTranscriptItem): string {
  if (section.completedAt !== undefined && section.items.length === 0 && !section.timing) return "";
  const summary = renderWorkingSummary(ctx, section);
  const commentary = commentaryContext(ctx);
  const commentaryHtml = section.items.filter((item) => item.type === "text").map((item) => renderTranscriptItem(commentary, item)).join("");
  const revealing = Boolean(ctx.revealTarget && section.items.some((item) => item.anchor === ctx.revealTarget || item.key === ctx.revealTarget));
  const attributes = ` data-controller="agent-turn" data-agent-turn-workspace-id-value="${escapeHtml(ctx.workspaceId)}" data-agent-turn-conversation-id-value="${escapeHtml(ctx.conversationId)}" data-agent-turn-turn-id-value="${escapeHtml(section.key)}" data-agent-turn-branch-id-value="${escapeHtml(ctx.branchId ?? "")}"${revealing ? ` open data-agent-turn-reveal-value="${escapeHtml(ctx.revealTarget!)}"` : ""} data-action="toggle->agent-turn#toggle"`;
  return `<div class="agent-working-block" id="${ids.item(ctx, section.key)}"><details class="agent-working"${attributes}>${summary}<div class="agent-working-items" id="${ids.workingItems(ctx, section.key)}" data-agent-turn-target="items"></div></details><div class="agent-working-commentary" id="${ids.workingItems(commentary, section.key)}">${commentaryHtml}</div></div>`;
}

export function renderWorkingSummary(ctx: AgentRenderContext, section: WorkingTranscriptItem): string {
  const steeringCount = section.items.filter((item) => item.type === "user" && item.steering).length;
  const endedAt = section.completedAt ?? section.stoppedAt;
  const active = endedAt === undefined;
  const duration = formatDuration(section.timing?.elapsedMs ?? ((endedAt ?? Date.now()) - section.startedAt));
  const activityLabel = `${active ? "Working for" : section.completedAt !== undefined ? "Worked for" : "Stopped after"} ${duration}`;
  const status = active ? '<i class="status-dot running action-item__status" aria-label="In progress"></i>' : "";
  return transcriptActionItemHtml({ kind: "text", text: activityLabel,
    attributesHtml: active ? `data-controller="agent-elapsed" data-agent-elapsed-since-value="${section.startedAt}" data-agent-elapsed-prefix-value="Working for "` : undefined,
    textAttributesHtml: active ? 'data-agent-elapsed-target="time"' : undefined,
  }, {
    disclosure: true, leadingHtml: status, trailingHtml: `${steeringCount ? `<span class="agent-working-timing">${steeringCount} steering ${steeringCount === 1 ? "message" : "messages"}</span>` : ""}${active ? "" : renderWorkingTiming(section)}${section.unreadQueueCount ? `<span class="agent-working-timing">${section.unreadQueueCount} unread ${section.unreadQueueCount === 1 ? "message" : "messages"} in queue</span>` : ""}`,
    summaryId: ids.itemSummaryContent(ctx, section.key),
  });
}

function renderWorkingTiming(section: Omit<WorkingTranscriptItem, "items">): string {
  if (!section.timing) return "";
  const timing = section.timing;
  const rate = timing.usageComplete && timing.inferenceMs > 0
    ? `${(timing.outputTokens / (timing.inferenceMs / 1000)).toFixed(0)} tps`
    : "tps unavailable";
  const toolDuration = formatDuration(timing.toolMs);
  const toolsLabel = toolDuration === "0s" ? "" : `${toolDuration} tools, `;
  return ` <span class="agent-working-timing" title="Wall-clock tool wait (parallel calls counted once). Output-token count and tokens per inference second, including reported thinking tokens.">(${escapeHtml(toolsLabel)}${timing.usageComplete ? `${formatTokens(timing.outputTokens)} tok` : "tokens unavailable"} @ ${escapeHtml(rate)})</span>`;
}

function renderThinkingItem(ctx: AgentRenderContext, item: Extract<TranscriptItem, { type: "thinking" }>): string {
  const renderer = thinkingBlockRendererFor(ctx.model);
  return transcriptRow(renderer({ contentId: ids.itemText(ctx, item.key), text: item.text }));
}

export function renderTranscriptItemDetailFrame(ctx: AgentRenderContext, item: TranscriptItem, options: { count?: number } = {}): string {
  const frameId = ids.detailFrame(ctx, item.key);
  let html = "";
  if (item.type === "working") html = renderWorkingItems(ctx, item);
  else if (item.type === "inherited-context") html = `<div class="agent-inherited-content"><p class="agent-inherited-explanation">Copied from ${escapeHtml(item.source)} at spawn time. Only selected user messages, final assistant text, and context summaries are retained; tool activity, reasoning, and intermediate messages are omitted.</p>${item.items.map((child) => renderTranscriptItem(ctx, child)).join("")}</div>`;
  else if (item.type === "tool") html = renderToolDetail(ctx, item.key, item.tool, options.count ?? 100);
  return `<turbo-frame id="${frameId}">${html}</turbo-frame>`;
}
