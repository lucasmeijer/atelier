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

export function transcriptActionItemHtml(label: ActionItemLabel, options: { disclosure: boolean; leadingHtml?: string; trailingHtml?: string; labelId?: string; summaryId?: string }): string {
  return actionItemHtml({
    kind: "single",
    primary: options.disclosure ? undefined : false,
    leadingHtml: `${options.disclosure ? Icons.Disclosure : ""}${options.leadingHtml ?? ""}`,
    trailingHtml: options.trailingHtml,
    label: { ...label, textAttributesHtml: options.labelId ? `id="${options.labelId}"` : undefined },
    element: { tag: options.disclosure ? "summary" : "div", attributesHtml: options.summaryId ? `id="${options.summaryId}"` : undefined },
  });
}

export function renderMarkdownRow(ctx: AgentRenderContext, text: string, className: string): string {
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
