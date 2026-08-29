import MarkdownIt from "markdown-it";
import { atelierFileHref, renderAtelierEmbed } from "./atelier-markdown.ts";
import { escapeHtml, workspaceProxyUrl } from "@atelier/shared";
import { highlightCodeHtml } from "@atelier/syntax";

export interface MarkdownRenderOptions {
  sourcePath?: string;
}

interface MarkdownEnvironment extends MarkdownRenderOptions {
  workspaceId: string;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

markdown.renderer.rules.table_open = () => '<div class="agent-table-scroll"><table>';
markdown.renderer.rules.table_close = () => "</table></div>";

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]!;
  const rawLang = token.info.trim().split(/\s+/)[0] || undefined;
  const codeText = token.content.replace(/\n$/, "");
  const highlighted = highlightCodeHtml({ code: codeText, language: rawLang });
  const attrs = [
    rawLang ? `data-lang="${escapeHtml(rawLang)}"` : "",
    highlighted.language ? `class="language-${escapeHtml(highlighted.language)}"` : "",
  ].filter(Boolean).join(" ");
  const label = rawLang ? `Copy ${escapeHtml(rawLang)} code to clipboard` : "Copy code to clipboard";
  return `<div class="agent-code-block" data-controller="agent-code-copy"><button type="button" class="agent-code-copy" data-agent-code-copy-target="button" data-action="agent-code-copy#copy" aria-label="${label}" title="Copy code"><span class="agent-code-copy-icon" aria-hidden="true">⧉</span></button><pre${attrs ? ` ${attrs}` : ""}><code data-agent-code-copy-target="code">${highlighted.html}</code></pre></div>`;
};

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
  if (!Number.isInteger(port) || port < 3000 || port > 3010 || url.protocol !== "http:") return undefined;
  return workspaceProxyUrl(workspaceId, `port-${port}`, `${url.pathname}${url.search}${url.hash}`);
}

export function renderMarkdown(workspaceId: string, text: string, options: MarkdownRenderOptions = {}): string {
  return markdown.render(text, { workspaceId, ...options } satisfies MarkdownEnvironment).trim();
}
