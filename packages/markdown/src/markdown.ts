import MarkdownIt from "markdown-it";
import { atelierFileHref, renderAtelierEmbed } from "./atelier-markdown.ts";
import { escapeHtml, workspaceProxyUrl } from "@atelier/shared";
import { highlightCodeHtml } from "@atelier/syntax";

export interface MarkdownRenderOptions {
  sourcePath?: string;
  frontmatter?: boolean;
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
  const [language, ...filenameParts] = token.info.trim().split(/\s+/);
  const rawLang = language || undefined;
  const filenameInfo = filenameParts.join(" ") || undefined;
  const filenameMatch = filenameInfo?.match(/^filename=(?:"([^"]*)"|'([^']*)'|(\S+))$/);
  const filename = filenameMatch ? (filenameMatch[1] ?? filenameMatch[2] ?? filenameMatch[3]) : filenameInfo;
  const codeText = token.content.replace(/\n$/, "");
  const highlighted = highlightCodeHtml({ code: codeText, language: rawLang });
  const attrs = [
    rawLang ? `data-lang="${escapeHtml(rawLang)}"` : "",
    highlighted.language ? `class="language-${escapeHtml(highlighted.language)}"` : "",
  ].filter(Boolean).join(" ");
  const label = rawLang ? `Copy ${escapeHtml(rawLang)} code to clipboard` : "Copy code to clipboard";
  const title = filename ?? (rawLang ? `${rawLang} code` : "Code");
  const headerLabel = filename ?? rawLang;
  const header = headerLabel
    ? `<div class="agent-code-block-header"${filename ? ` title="${escapeHtml(filename)}"` : ""}>${escapeHtml(headerLabel)}</div>`
    : "";
  const preOpen = `<pre${attrs ? ` ${attrs}` : ""}>`;
  const inlineCode = `${preOpen}<code data-agent-code-copy-target="code">${highlighted.html}</code></pre>`;
  const fullscreenCode = `${preOpen}<code>${highlighted.html}</code></pre>`;
  return `<div class="agent-code-block" data-controller="agent-code-copy atelier-fullscreen" data-atelier-fullscreen-mode-value="template" data-atelier-fullscreen-title-value="${escapeHtml(title)}"><button type="button" class="agent-code-copy" data-agent-code-copy-target="button" data-action="agent-code-copy#copy" aria-label="${label}" title="Copy code"><span class="agent-code-copy-icon" aria-hidden="true">⧉</span></button>${header}${inlineCode}<template data-atelier-fullscreen-target="content"><div class="agent-code-block">${fullscreenCode}</div></template></div>`;
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

function withoutFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
}

export function renderMarkdown(workspaceId: string, text: string, options: MarkdownRenderOptions = {}): string {
  const source = options.frontmatter ? withoutFrontmatter(text) : text;
  return markdown.render(source, { workspaceId, ...options } satisfies MarkdownEnvironment).trim();
}
