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

export function disclosureActionItemHtml(label: ActionItemLabel, options: { leadingHtml?: string; labelId?: string } = {}): string {
  return actionItemHtml({
    kind: "single",
    leadingHtml: `${Icons.Disclosure}${options.leadingHtml ?? ""}`,
    label: { ...label, textAttributesHtml: options.labelId ? `id="${options.labelId}"` : undefined },
    element: { tag: "summary" },
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
