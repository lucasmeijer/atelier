import { copyButtonHtml } from "@atelier/design-system/copy-button";
import { buttonHtml } from "@atelier/design-system/button";
import MarkdownIt from "markdown-it";
import { atelierFileHref, renderAtelierEmbed } from "./atelier-markdown.ts";
import { escapeHtml, isWorkspaceAppPort, workspaceProxyUrl } from "@atelier/shared";
import { renderMarkdownDiff } from "@atelier/syntax/markdown-diff";
import { highlightCodeHtml } from "@atelier/syntax";

export interface MarkdownRenderOptions {
  sourcePath?: string;
  frontmatter?: boolean;
}

interface MarkdownEnvironment extends MarkdownRenderOptions {
  workspaceId: string;
  provisional?: boolean;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

markdown.renderer.rules.table_open = () => '<div class="agent-table-scroll"><table>';
markdown.renderer.rules.table_close = () => "</table></div>";

markdown.renderer.rules.fence = (tokens, index, _options, environment: MarkdownEnvironment) => {
  const token = tokens[index]!;
  const [language, ...filenameParts] = token.info.trim().split(/\s+/);
  const rawLang = language || undefined;
  const filenameInfo = filenameParts.join(" ") || undefined;
  const filenameMatch = filenameInfo?.match(/^filename=(?:"([^"]*)"|'([^']*)'|(\S+))$/);
  const filename = filenameMatch ? (filenameMatch[1] ?? filenameMatch[2] ?? filenameMatch[3]) : filenameInfo;
  const codeText = token.content.replace(/\n$/, "");
  if (rawLang?.toLowerCase() === "mermaid") return environment.provisional ? renderPendingMermaid(filename) : renderMermaid(codeText, filename);
  const isDiff = rawLang?.toLowerCase() === "diff";
  const code = isDiff ? renderMarkdownDiff(codeText, environment.provisional) : renderHighlightedFence(codeText, rawLang);
  const label = isDiff ? "Copy diff to clipboard" : rawLang ? `Copy ${rawLang} code to clipboard` : "Copy code to clipboard";
  const title = filename ?? (isDiff ? "Diff" : rawLang ? `${rawLang} code` : "Code");
  const headerClass = isDiff ? "markdown-diff-filename" : "agent-code-block-header";
  const header = filename ? `<div class="${headerClass}" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>` : "";
  const classes = `agent-code-block copy-region${isDiff ? " markdown-diff" : ""}`;
  const content = `${copyButtonHtml({ label, copyText: isDiff ? token.content : undefined })}${header}${code}`;
  return `<div class="${classes}" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(title)}">${content}<template data-atelier-fullscreen-target="content"><div class="${classes}">${content}</div></template></div>`;
};

function renderHighlightedFence(code: string, language?: string): string {
  const highlighted = highlightCodeHtml({ code, language });
  const attrs = [
    language ? `data-lang="${escapeHtml(language)}"` : "",
    highlighted.language ? `class="language-${escapeHtml(highlighted.language)}"` : "",
  ].filter(Boolean).join(" ");
  return `<pre${attrs ? ` ${attrs}` : ""}><code data-copy-source>${highlighted.html}</code></pre>`;
}

function mermaidDiagram(source: string, fullscreen = false): string {
  return `<div class="agent-mermaid-diagram${fullscreen ? " agent-mermaid-diagram-fullscreen" : ""}" data-controller="agent-mermaid"><div class="agent-mermaid-canvas" data-agent-mermaid-target="diagram" aria-busy="true"><pre data-agent-mermaid-target="source" hidden>${escapeHtml(source)}</pre></div></div>`;
}

function renderMermaid(source: string, filename?: string): string {
  const title = filename ?? "Mermaid diagram";
  const header = filename ? `<div class="agent-media-frame-bar"><span>${escapeHtml(filename)}</span>${buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Fullscreen" }, attributesHtml: 'data-action="atelier-fullscreen#open"' })}</div>` : "";
  return `<div class="agent-media-frame agent-mermaid" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(title)}">${header}${mermaidDiagram(source)}<template data-atelier-fullscreen-target="content">${mermaidDiagram(source, true)}</template></div>`;
}

function renderPendingMermaid(filename?: string): string {
  const header = filename ? `<div class="agent-media-frame-bar"><span>${escapeHtml(filename)}</span></div>` : "";
  return `<div class="agent-media-frame agent-mermaid">${header}<div class="agent-mermaid-diagram"><div class="agent-mermaid-canvas" aria-busy="true"></div></div></div>`;
}

const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, index, options, _environment, renderer) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, environment: MarkdownEnvironment, renderer) => {
  const token = tokens[index]!;
  const href = token.attrGet("href") ?? "";
  const fileHref = atelierFileHref(environment.workspaceId, href, environment.sourcePath);
  if (fileHref) {
    token.attrSet("href", fileHref);
    token.attrSet("data-turbo-stream", "true");
    return defaultLinkOpen(tokens, index, options, environment, renderer);
  }

  const workspaceLocalHref = workspaceLocalPreviewHref(environment.workspaceId, href);
  if (workspaceLocalHref) token.attrSet("href", workspaceLocalHref);
  if (href.startsWith("http://") || href.startsWith("https://")) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  }
  return defaultLinkOpen(tokens, index, options, environment, renderer);
};

const defaultImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, environment: MarkdownEnvironment, renderer) => {
  const source = tokens[index]!.attrGet("src") ?? "";
  if (source.startsWith("atelier-embed:")) {
    return renderAtelierEmbed(environment.workspaceId, source.slice("atelier-embed:".length));
  }
  return defaultImage(tokens, index, options, environment, renderer);
};

function workspaceLocalPreviewHref(workspaceId: string, href: string): string | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  const hostname = url.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(hostname)) return undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!isWorkspaceAppPort(port) || url.protocol !== "http:") return undefined;
  return workspaceProxyUrl(workspaceId, `port-${port}`, `${url.pathname}${url.search}${url.hash}`);
}

function withoutFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
}

export function renderMarkdown(workspaceId: string, text: string, options: MarkdownRenderOptions = {}): string {
  const source = options.frontmatter ? withoutFrontmatter(text) : text;
  return markdown.render(source, { workspaceId, ...options } satisfies MarkdownEnvironment).trim();
}

export function renderProvisionalMarkdown(workspaceId: string, text: string): string {
  return markdown.render(text, { workspaceId, provisional: true } satisfies MarkdownEnvironment).trim();
}
