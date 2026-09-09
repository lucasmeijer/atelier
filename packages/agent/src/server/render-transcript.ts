import { renderStreamingMarkdownSnapshot } from "@atelier/markdown";
import { escapeHtml } from "./html.ts";
import { thinkingBlockRendererFor } from "./thinking-block-renderers.ts";
import { formatDuration, formatTokens, type TranscriptItem, type WorkingTranscriptItem, type SessionImageRef } from "./transcript.ts";
import { ids, sessionImageUrl, transcriptItemPath, type AgentRenderContext } from "./render-context.ts";
import { codeBlockHtml, detailFullscreen, fullscreenAttributes, markdown, renderMarkdownRow, transcriptActionItemHtml, transcriptRow } from "./render-markup.ts";
import { renderToolCard, renderToolDetail, statusHtml, tailFrameAttributes } from "./render-tool.ts";

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

function lazyTranscriptItemFrame(ctx: AgentRenderContext, key: string, tail = false): string {
  const attributes = tail ? tailFrameAttributes(ctx, key) : `id="${ids.detailFrame(ctx, key)}"`;
  return `<turbo-frame ${attributes} data-agent-lazy-detail-target="frame" data-src="${escapeHtml(transcriptItemPath(ctx, key))}"></turbo-frame>`;
}

export function renderTranscript(ctx: AgentRenderContext, items: TranscriptItem[], modelContext: AgentModelContextView): string {
  return `${renderModelContextCard(ctx, modelContext)}${items.map((item) => renderTranscriptItem(ctx, item)).join("")}<div class="agent-notices" id="${ids.notices(ctx)}"></div>`;
}

function renderModelContextCard(ctx: AgentRenderContext, modelContext: AgentModelContextView): string {
  const prompt = modelContext.systemPrompt.trim();
  const tools = modelContext.tools;
  if (!prompt && tools.length === 0) return "";
  const meta = [prompt ? "system-prompt.md" : undefined, tools.length ? `tools.json (${tools.length})` : undefined].filter(Boolean).join(" · ");
  const label = `model_context · ${meta}`;
  return transcriptRow(`<details class="agent-tool tool-model-context" data-agent-historical-detail data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load">${transcriptActionItemHtml({ kind: "text", text: label }, { disclosure: true, leadingHtml: statusHtml("ok") })}${lazyTranscriptItemFrame(ctx, "model-context", true)}</details>`);
}

export function renderModelContextDetailFrame(ctx: AgentRenderContext, modelContext: AgentModelContextView): string {
  const prompt = modelContext.systemPrompt.trim();
  const blocks = [prompt ? codeBlockHtml(prompt, "system-prompt.md") : "", modelContext.tools.length ? codeBlockHtml(JSON.stringify(modelContext.tools, null, 2), "tools.json") : ""].filter(Boolean).join("");
  return `<turbo-frame id="${ids.detailFrame(ctx, "model-context")}"><div class="agent-tool-detail">${detailFullscreen("Model context", blocks)}</div></turbo-frame>`;
}

function renderUserMessage(ctx: AgentRenderContext, user: { text: string; images: SessionImageRef[] }): string {
  const images = user.images.length ? `<div class="agent-user-attachments">${user.images.map((image) => `<img${fullscreenAttributes("attachment", "media")} src="${escapeHtml(sessionImageUrl(ctx, image))}" alt="attachment" loading="lazy">`).join("")}</div>` : "";
  return transcriptRow(`<div class="agent-user" data-agent-user-text="${escapeHtml(user.text)}"><div class="agent-user-bubble markdown">${markdown(ctx, user.text)}${images}</div></div>`);
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
    body = transcriptRow(`<details data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load">${transcriptActionItemHtml({ kind: "text", text: label }, { disclosure: true })}${lazyTranscriptItemFrame(ctx, item.key)}</details>`);
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
  const revealing = Boolean(ctx.revealTarget && section.items.some((item) => item.anchor === ctx.revealTarget || item.key === ctx.revealTarget));
  const attributes = ` data-controller="agent-turn" data-agent-turn-workspace-id-value="${escapeHtml(ctx.workspaceId)}" data-agent-turn-conversation-id-value="${escapeHtml(ctx.conversationId)}" data-agent-turn-turn-id-value="${escapeHtml(section.key)}" data-agent-turn-branch-id-value="${escapeHtml(ctx.branchId ?? "")}"${revealing ? ` open data-agent-turn-reveal-value="${escapeHtml(ctx.revealTarget!)}"` : ""} data-action="toggle->agent-turn#toggle"`;
  return `<details class="agent-working" id="${ids.item(ctx, section.key)}"${attributes}>${summary}<div class="agent-working-items" id="${ids.workingItems(ctx, section.key)}" data-agent-turn-target="items"></div></details>`;
}

export function renderWorkingSummary(ctx: AgentRenderContext, section: Omit<WorkingTranscriptItem, "items">): string {
  const endedAt = section.completedAt ?? section.stoppedAt;
  const active = endedAt === undefined;
  const duration = formatDuration(section.timing?.elapsedMs ?? ((endedAt ?? Date.now()) - section.startedAt));
  const activityLabel = `${active ? "Working for" : section.completedAt !== undefined ? "Worked for" : "Stopped after"} ${duration}`;
  const status = active ? '<i class="status-dot running action-item__status" aria-label="In progress"></i>' : "";
  return transcriptActionItemHtml({ kind: "text", text: activityLabel,
    attributesHtml: active ? `data-controller="agent-elapsed" data-agent-elapsed-since-value="${section.startedAt}" data-agent-elapsed-prefix-value="Working for "` : undefined,
    textAttributesHtml: active ? 'data-agent-elapsed-target="time"' : undefined,
  }, {
    disclosure: true, leadingHtml: status, trailingHtml: active ? "" : renderWorkingTiming(section),
    summaryId: ids.itemSummaryContent(ctx, section.key),
  });
}

function renderWorkingTiming(section: Omit<WorkingTranscriptItem, "items">): string {
  if (!section.timing) return "";
  const timing = section.timing;
  const rate = timing.usageComplete && timing.inferenceMs > 0
    ? `${(timing.outputTokens / (timing.inferenceMs / 1000)).toFixed(1)} tps`
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
