import { Icons } from "@atelier/design-system/icons";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { renderStreamingMarkdownSnapshot } from "@atelier/markdown";
import { escapeHtml } from "./html.ts";
import { thinkingBlockRendererFor } from "./thinking-block-renderers.ts";
import { formatDuration, formatTokens, type TranscriptItem, type SubagentTranscriptMessage, type WorkingTranscriptItem, type SessionImageRef } from "./transcript.ts";
import { ids, sessionImageUrl, transcriptItemPath, type AgentRenderContext } from "./render-context.ts";
import { codeBlockHtml, communicationCardHtml, communicationEnvelopeHtml, communicationTraceHtml, detailFullscreen, fullscreenAttributes, markdown, renderMarkdownRow, transcriptActionItemHtml, transcriptRow } from "./render-markup.ts";
import { renderToolCard, renderToolDetail, statusHtml, tailFrameAttributes } from "./render-tool.ts";

function incomingHandling(message: SubagentTranscriptMessage): string {
  if (message.dispatchMode === "immediate") return message.deliveredEnvelope
    ? "Delivered straight away because the agent was idle and this task starts a new inference."
    : "Immediate delivery requested because the agent was idle and this task starts a new inference.";
  switch (message.dispatchReason) {
    case "idle-message": return "Queued for a later turn because the agent was idle and ordinary messages do not start new inferences.";
    case "working": return "Queued because the agent was still working, to be consumed at the next model-request boundary.";
    case "waiting": return "Queued because the agent was waiting in wait_agent, to be consumed when it resumes after the tool returns.";
    default: return message.dispatchMode === "queued" ? "Queued on arrival; the reason was not recorded." : message.delivery === "failed" ? "Delivery failed before a dispatch decision was recorded." : message.delivery === "delivered" ? "Added to session context; the original dispatch reason was not recorded." : "Received; the dispatch decision is pending.";
  }
}

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
  return transcriptRow(`<div class="agent-user" data-agent-user-text="${escapeHtml(user.text)}"><div class="agent-user-bubble">${markdown(ctx, user.text)}${images}</div></div>`);
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
  else if (item.type === "tool") body = transcriptRow(renderToolCard(ctx, item.key, item.tool, { ...options, open: options.open || Boolean(item.communicationId && item.communicationId === ctx.revealCommunicationId) }));
  else if (item.type === "note" && item.modelDelivery) {
    const batch = item.modelDelivery;
    const count = batch.messages.length;
    const label = `Delivered ${count} ${count === 1 ? "message" : "messages"} from queue. ${batch.remaining ? `${batch.remaining} remaining in queue.` : "Queue is now empty."}`;
    body = transcriptRow(`<details class="agent-communication agent-model-delivery" data-controller="agent-communication" data-agent-communication-key-value="${escapeHtml(`${ctx.workspaceId}:${ctx.conversationId}:${item.key}`)}" data-action="toggle->agent-communication#remember">
      ${transcriptActionItemHtml({ kind: "text", text: label }, { disclosure: true, leadingHtml: statusHtml("ok") })}
      <p class="agent-delivery-boundary">Included in a prepared model request; not a read receipt. Queue size is recorded at that moment.</p>
      ${batch.messages.map((message) => communicationCardHtml([
        { label: "Received", html: communicationTraceHtml(ctx, message.recipient, message.id, "here", "") },
        ...(batch.format === "user" ? [{ label: "Delivery kind", html: "Converted to user message" }] : []),
        { label: "Delivered as", html: communicationEnvelopeHtml(message.envelope) },
      ])).join("")}
    </details>`);
  }
  else if (item.type === "note" && item.communication) {
    const message = item.communication;
    const state = message.delivery === "queued" ? "Pending context" : message.delivery === "failed" ? "Delivery failed" : "";
    const kind = message.kind === "message" ? "update" : message.kind === "completion" ? "completed" : message.kind;
    const label = `Incoming ${kind} message from ${message.path}`;
    body = transcriptRow(`<details class="agent-communication" data-communication-id="${escapeHtml(message.id)}" data-controller="agent-communication" data-agent-communication-key-value="${escapeHtml(`${ctx.workspaceId}:${ctx.conversationId}:${message.id}`)}" data-action="toggle->agent-communication#remember" open>
      ${actionItemHtml({ kind: "single", element: { tag: "summary", attributesHtml: `title="${escapeHtml(label)}"` }, leadingHtml: `${Icons.Disclosure}<i class="status-dot success action-item__status" aria-label="Incoming message"></i>`, label: { kind: "text", text: label } })}
      ${communicationCardHtml([
        { label: "Type", html: escapeHtml(kind) },
        { label: "Source", html: communicationTraceHtml(ctx, message.agentId, message.id, `Sent from ${message.path} here`, "") },
        ...(!message.deliveredEnvelope ? [{ label: "Body", html: `<div class="agent-communication-body">${escapeHtml(item.text)}</div>` }] : []),
        { label: "Handling", html: escapeHtml(incomingHandling(message)) },
        ...(message.deliveredEnvelope ? [
          ...(message.deliveredFormat === "user" ? [{ label: "Delivery kind", html: "Converted to user message" }] : []),
          { label: "Delivered as", html: communicationEnvelopeHtml(message.deliveredEnvelope) },
        ] : state ? [{ label: "Context", html: escapeHtml(state) }] : []),
      ])}
    </details>`);
  }
  else if (item.type === "note") body = renderMarkdownRow(ctx, item.text, `agent-note ${escapeHtml(item.tone)}`);
  else body = transcriptRow(`<div class="agent-error">${escapeHtml(item.text)}</div>`);
  return `<div class="agent-item" id="${id}"${item.communicationId ? ` data-communication-id="${escapeHtml(item.communicationId)}"` : ""}>${body}</div>`;
}

function renderWorkingItems(ctx: AgentRenderContext, section: WorkingTranscriptItem, options: { live?: boolean; open?: boolean } = {}): string {
  const items = section.items.map((item) => renderTranscriptItem(ctx, item, options)).join("");
  return `<div class="agent-working-items" id="${ids.workingItems(ctx, section.key)}">${items}</div>`;
}

function renderWorkingSection(ctx: AgentRenderContext, section: WorkingTranscriptItem): string {
  if (section.completedAt !== undefined && section.items.length === 0 && !section.timing) return "";
  const endedAt = section.completedAt ?? section.stoppedAt;
  const active = endedAt === undefined;
  const activityLabel = active ? "Working"
    : `${section.completedAt !== undefined ? "Worked for" : "Stopped after"} ${formatDuration(section.timing?.elapsedMs ?? (endedAt - section.startedAt))}`;
  const timingLabel = renderWorkingTiming(section);
  const status = active ? '<i class="status-dot running action-item__status" aria-label="In progress"></i>' : "";
  const summary = transcriptActionItemHtml({ kind: "text", text: activityLabel }, { disclosure: true, leadingHtml: status, trailingHtml: timingLabel });
  const emptyClass = section.items.length === 0 ? " agent-working--empty" : "";
  const revealing = Boolean(ctx.revealCommunicationId && section.items.some((item) => item.communicationId === ctx.revealCommunicationId));
  const lazy = !active && !section.live && !revealing;
  const attributes = lazy ? ' data-controller="agent-lazy-detail" data-action="toggle->agent-lazy-detail#load mouseenter->agent-lazy-detail#load"' : active || revealing ? " open" : "";
  const items = lazy ? lazyTranscriptItemFrame(ctx, section.key) : renderWorkingItems(ctx, section, { live: section.live, open: active });
  return `<details class="agent-working${emptyClass}${active ? " active" : ""}" id="${ids.item(ctx, section.key)}"${attributes}>${summary}${items}</details>`;
}

function renderWorkingTiming(section: WorkingTranscriptItem): string {
  if (section.completedAt === undefined || !section.timing) return "";
  const timing = section.timing;
  const rate = timing.usageComplete && timing.inferenceMs > 0
    ? `${(timing.outputTokens / (timing.inferenceMs / 1000)).toFixed(1)} tps`
    : "tps unavailable";
  const toolDuration = formatDuration(timing.toolMs);
  const toolsLabel = toolDuration === "0s" ? "" : `${toolDuration} tools, `;
  return ` <span class="agent-working-timing" title="Wall-clock tool wait (parallel calls counted once). Output-token count and tokens per inference second, including reported thinking tokens.">(${escapeHtml(toolsLabel)}${formatTokens(timing.outputTokens)} tok @ ${escapeHtml(rate)})</span>`;
}

function renderThinkingItem(ctx: AgentRenderContext, item: Extract<TranscriptItem, { type: "thinking" }>): string {
  const renderer = thinkingBlockRendererFor(ctx.model);
  return transcriptRow(renderer({ contentId: ids.itemText(ctx, item.key), text: item.text }));
}

export function renderTranscriptItemDetailFrame(ctx: AgentRenderContext, item: TranscriptItem, options: { count?: number } = {}): string {
  const frameId = ids.detailFrame(ctx, item.key);
  let html = "";
  if (item.type === "working") html = renderWorkingItems(ctx, item);
  else if (item.type === "tool") html = renderToolDetail(ctx, item.key, item.tool, options.count ?? 100);
  return `<turbo-frame id="${frameId}">${html}</turbo-frame>`;
}
