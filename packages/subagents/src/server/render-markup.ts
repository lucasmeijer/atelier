import { escapeHtml, type AgentRenderContext } from "@atelier/agent/server";

/** Communication details share the standard tool card, with labelled data rows. */
export function communicationCardHtml(rows: Array<{ label: string; html: string }>): string {
  return `<div class="agent-tool-detail"><table class="agent-communication-table"><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${row.html}</td></tr>`).join("")}</tbody></table></div>`;
}

export function communicationTraceHtml(ctx: AgentRenderContext, agentId: string, messageId: string, label: string, path: string): string {
  const query = new URLSearchParams({ child: agentId, message: messageId });
  return `<a href="/workspaces/${encodeURIComponent(ctx.workspaceId)}/subagents/reveal?${escapeHtml(query.toString())}" data-turbo="false" class="agent-trace-link">${escapeHtml(label)}${path ? ` · ${escapeHtml(path)}` : ""}</a>`;
}

export function communicationEnvelopeHtml(envelope: string): string {
  return `<div class="agent-communication-body" title="Included in a prepared model request; not a read receipt">${escapeHtml(envelope)}</div>`;
}
