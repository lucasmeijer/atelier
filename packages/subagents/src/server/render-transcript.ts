import { Icons } from "@atelier/design-system/icons";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { escapeHtml, transcriptRow, transcriptActionItemHtml, statusHtml, type AgentRenderContext } from "@atelier/agent/server";
import { communicationCardHtml, communicationEnvelopeHtml, communicationTraceHtml } from "./render-markup.ts";
import type { SubagentMessage } from "./subagent-runtime.ts";
import type { SubagentDelivery } from "./subagent-delivery.ts";
export interface SubagentTranscriptMessage {
  dispatchMode?: SubagentMessage["dispatchMode"];
  dispatchReason?: SubagentMessage["dispatchReason"];
  deliveredEnvelope?: string;
  deliveredFormat?: "agent_message" | "user";
  id: string; rootId: string; agentId: string; path: string; kind: string;
  delivery: "queued" | "delivered" | "failed";
}

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

export interface CommunicationView { key: string; text: string; modelDelivery?: SubagentDelivery; communication?: SubagentTranscriptMessage }
export function renderCommunication(ctx: AgentRenderContext, item: CommunicationView): string {
  let body = "";
  if (item.modelDelivery) {
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
  else if (item.communication) {
    const message = item.communication;
    const state = message.delivery === "queued" ? "Pending context" : message.delivery === "failed" ? "Delivery failed" : "";
    const kind = message.kind === "message" ? "update" : message.kind === "completion" ? "completed" : message.kind;
    const label = `Incoming ${kind} message from ${message.path}`;
    body = transcriptRow(`<details class="agent-communication" data-transcript-anchor="${escapeHtml(message.id)}" data-controller="agent-communication" data-agent-communication-key-value="${escapeHtml(`${ctx.workspaceId}:${ctx.conversationId}:${message.id}`)}" data-action="toggle->agent-communication#remember" open>
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

  return body;
}
