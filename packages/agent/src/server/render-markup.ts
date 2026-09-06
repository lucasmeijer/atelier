import { actionItemHtml, type ActionItemLabel } from "@atelier/design-system/action-item";
import { Icons } from "@atelier/design-system/icons";
import { renderMarkdown } from "@atelier/markdown";
import { highlightCodeHtmlForPath } from "@atelier/syntax";
import { escapeHtml } from "./html.ts";
import type { AgentRenderContext } from "./render-context.ts";

export function markdown(ctx: AgentRenderContext, text: string): string {
  return renderMarkdown(ctx.workspaceId, text);
}

export function transcriptRow(html: string): string {
  return `<div class="agent-row">${html}</div>`;
}

export function transcriptActionItemHtml(label: ActionItemLabel, options: { disclosure: boolean; leadingHtml?: string; trailingHtml?: string; labelId?: string }): string {
  return actionItemHtml({
    kind: "single",
    primary: options.disclosure ? undefined : false,
    leadingHtml: `${options.disclosure ? Icons.Disclosure : ""}${options.leadingHtml ?? ""}`,
    trailingHtml: options.trailingHtml,
    label: { ...label, textAttributesHtml: options.labelId ? `id="${options.labelId}"` : undefined },
    element: { tag: options.disclosure ? "summary" : "div" },
  });
}

export function renderMarkdownRow(ctx: AgentRenderContext, text: string, className = "agent-md"): string {
  const body = markdown(ctx, text);
  return body ? transcriptRow(`<div class="${className}">${body}</div>`) : "";
}

export function fullscreenAttributes(title: string, mode: "template" | "media" = "template"): string {
  return ` data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="${mode}" data-atelier-fullscreen-title-value="${escapeHtml(title)}"`;
}

export function detailFullscreen(title: string, html: string): string {
  return `<div class="agent-detail-fullscreen"${fullscreenAttributes(title)}>${html}<template data-atelier-fullscreen-target="content">${html}</template></div>`;
}

export function codeBlockHtml(code: string, filePath: string | undefined, className = "agent-tool-code"): string {
  const highlighted = highlightCodeHtmlForPath(code, filePath);
  const languageClass = highlighted.language ? ` language-${escapeHtml(highlighted.language)}` : "";
  return `<pre class="${className}${languageClass}"><code>${highlighted.html}</code></pre>`;
}

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
