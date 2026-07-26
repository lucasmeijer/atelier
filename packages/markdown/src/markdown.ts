import MarkdownIt from "markdown-it";
import { atelierFileEditorHref, renderAtelierEmbed } from "./atelier-markdown.ts";
import { escapeHtml } from "@atelier/shared";
import { highlightCodeHtml } from "./highlight.ts";

interface MarkdownEnvironment {
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
  const highlighted = highlightCodeHtml(codeText, rawLang);
  const attrs = [
    rawLang ? `data-lang="${escapeHtml(rawLang)}"` : "",
    highlighted.language ? `class="language-${escapeHtml(highlighted.language)}"` : "",
  ].filter(Boolean).join(" ");
  const label = rawLang ? `Copy ${escapeHtml(rawLang)} code to clipboard` : "Copy code to clipboard";
  return `<div class="agent-code-block" data-controller="agent-code-copy"><button type="button" class="agent-code-copy" data-action="agent-code-copy#copy" aria-label="${label}" title="Copy code"><span class="agent-code-copy-icon" aria-hidden="true">⧉</span></button><pre${attrs ? ` ${attrs}` : ""}><code data-agent-code-copy-target="code">${highlighted.html}</code></pre></div>`;
};

const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, index, options, _environment, renderer) => renderer.renderToken(tokens, index, options));
markdown.renderer.rules.link_open = (tokens, index, options, environment: MarkdownEnvironment, renderer) => {
  const token = tokens[index]!;
  const href = token.attrGet("href") ?? "";
  const editorHref = atelierFileEditorHref(environment.workspaceId, href);
  if (editorHref) {
    token.attrSet("href", editorHref);
    token.attrSet("data-turbo-stream", "true");
    return defaultLinkOpen(tokens, index, options, environment, renderer);
  }

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

export function renderMarkdown(workspaceId: string, text: string): string {
  return markdown.render(text, { workspaceId } satisfies MarkdownEnvironment).trim();
}
