import { escapeHtml, transcriptRow, transcriptActionItemHtml, statusHtml, type AgentRenderContext } from "@atelier/agent/server";
import { communicationCardHtml, communicationEnvelopeHtml, communicationTraceHtml } from "./render-markup.ts";
import type { SubagentMessage } from "./subagent-runtime.ts";
import type { SubagentDelivery } from "./subagent-delivery.ts";
interface SubagentTranscriptMessage extends Pick<SubagentMessage, "id" | "kind" | "delivery" | "dispatchMode" | "dispatchReason" | "queueSizeOnArrival"> {
  agentId: string;
  path: string;
  immediateRead?: { envelope: string; format: "agent_message" | "user" };
}

function incomingHandling(message: SubagentTranscriptMessage): string {
  if (message.dispatchMode === "immediate") return message.immediateRead
    ? "Read straight away because the agent was idle and this task starts a new inference."
    : "Immediate reading pending because the agent was idle and this task starts a new inference.";
  switch (message.dispatchReason) {
    case "idle-message": return "Queued for a later turn because the agent was idle and ordinary messages do not start new inferences.";
    case "working": return "Queued because the agent was still working, to be consumed at the next model-request boundary.";
    case "waiting": return "Queued because the agent was waiting in wait_agent, to be consumed when it resumes after the tool returns.";
    default: return message.dispatchMode === "queued" ? "Queued on arrival; the reason was not recorded." : message.delivery === "failed" ? "Delivery failed before a dispatch decision was recorded." : message.delivery === "delivered" ? "Added to session context; the original dispatch reason was not recorded." : "Received; the dispatch decision is pending.";
  }
}

function messageKind(kind: string): string {
  return kind === "message" ? "update" : kind === "completion" ? "completed" : kind;
}

function queueCaption(count: number): string {
  return `queue now has ${count} ${count === 1 ? "message" : "messages"}.`;
}

export type CommunicationView = { key: string } & (
  | { text: string; communication: SubagentTranscriptMessage }
  | { modelDelivery: SubagentDelivery; queuedSource?: { path: string; kind: string } }
);
export function renderCommunication(ctx: AgentRenderContext, item: CommunicationView): string {
  if ("modelDelivery" in item) {
    const batch = item.modelDelivery;
    const count = batch.messages.length;
    const label = item.queuedSource
      ? `Read queued ${messageKind(item.queuedSource.kind)} message from ${item.queuedSource.path}, ${queueCaption(batch.remaining)}`
      : `Read ${count} queued ${count === 1 ? "message" : "messages"}, ${queueCaption(batch.remaining)}`;
    return transcriptRow(`<details class="agent-communication agent-model-delivery" data-controller="agent-communication" data-agent-communication-key-value="${escapeHtml(`${ctx.workspaceId}:${ctx.conversationId}:${item.key}`)}" data-action="toggle->agent-communication#remember" open>
      ${transcriptActionItemHtml({ kind: "text", text: label, attributesHtml: `title="${escapeHtml(label)}"` }, { disclosure: true, leadingHtml: statusHtml("ok") })}
      ${batch.messages.map((message) => communicationCardHtml([
        { label: "Received", html: communicationTraceHtml(ctx, message.recipient, message.id, "Follow this link") },
        ...(batch.format === "user" ? [{ label: "Context format", html: "Converted to user message" }] : []),
        { label: "Read as", html: communicationEnvelopeHtml(message.envelope) },
      ])).join("")}
    </details>`);
  }
  const message = item.communication;
  const state = message.delivery === "queued" ? "Pending context" : message.delivery === "failed" ? "Delivery failed" : "";
  const kind = messageKind(message.kind);
  const incoming = `${kind} message from ${message.path}`;
  const label = message.immediateRead ? `Read incoming ${incoming}`
    : message.delivery === "failed" ? `Failed incoming ${incoming}`
    : message.dispatchMode === "queued" ? `Queued incoming ${incoming}${message.queueSizeOnArrival === undefined ? ". Queue size was not recorded." : `, ${queueCaption(message.queueSizeOnArrival)}`}`
    : `Incoming ${incoming} (pending read)`;
  return transcriptRow(`<details class="agent-communication" data-transcript-anchor="${escapeHtml(message.id)}" data-controller="agent-communication" data-agent-communication-key-value="${escapeHtml(`${ctx.workspaceId}:${ctx.conversationId}:${message.id}`)}" data-action="toggle->agent-communication#remember"${message.immediateRead || message.dispatchMode !== "queued" ? " open" : ""}>
    ${transcriptActionItemHtml({ kind: "text", text: label, attributesHtml: `title="${escapeHtml(label)}"` }, { disclosure: true, leadingHtml: statusHtml("ok") })}
    ${communicationCardHtml([
      { label: "Type", html: escapeHtml(kind) },
      { label: "Source", html: communicationTraceHtml(ctx, message.agentId, message.id, `Sent from ${message.path} here`) },
      ...(!message.immediateRead ? [{ label: "Body", html: `<div class="agent-communication-body">${escapeHtml(item.text)}</div>` }] : []),
      { label: "Handling", html: escapeHtml(incomingHandling(message)) },
      ...(message.immediateRead ? [
        { label: "Read", html: "Included in a prepared model request, not acknowledgement by the model." },
        ...(message.immediateRead.format === "user" ? [{ label: "Context format", html: "Converted to user message" }] : []),
        { label: "Read as", html: communicationEnvelopeHtml(message.immediateRead.envelope) },
      ] : state ? [{ label: "Context", html: escapeHtml(state) }] : []),
    ])}
  </details>`);
}
