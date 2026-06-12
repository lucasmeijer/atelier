import { escapeHtml } from "./html.ts";
import { highlightCodeHtml } from "./highlight.ts";

/**
 * Minimal server-side markdown renderer for assistant messages.
 * Supports: headings, fenced code blocks, inline code, bold, italics, links,
 * unordered/ordered lists, blockquotes, paragraphs.
 *
 * An optional `rewriteSegment` hook lets callers turn explicit embed directives
 * into HTML; it receives raw (unescaped) text segments outside of code
 * spans/blocks and returns HTML.
 */
export interface MarkdownOptions {
  rewriteSegment?: (rawText: string) => string | undefined;
  highlightCode?: boolean;
}

function inline(raw: string, options: MarkdownOptions): string {
  // Split out inline code first; never rewrite inside code.
  const parts = raw.split(/(`[^`]*`)/);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      const rewritten = options.rewriteSegment?.(part);
      if (rewritten !== undefined) return rewritten;
      let html = escapeHtml(part);
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`);
      html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
      return html;
    })
    .join("");
}

export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join("\n"), options)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    out.push(`<${tag}>${list.items.map((item) => `<li>${inline(item, options)}</li>`).join("")}</${tag}>`);
    list = undefined;
  };

  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // closing fence
      const rawLang = fence[1] || undefined;
      const codeText = code.join("\n");
      const highlighted = options.highlightCode === false ? { html: escapeHtml(codeText), language: undefined } : highlightCodeHtml(codeText, rawLang);
      const attrs = [
        rawLang ? `data-lang="${escapeHtml(rawLang)}"` : "",
        highlighted.language ? `class="language-${escapeHtml(highlighted.language)}"` : "",
      ].filter(Boolean).join(" ");
      out.push(`<pre${attrs ? ` ${attrs}` : ""}><code>${highlighted.html}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 2, 6); // h3..h6: keep transcript headings small
      out.push(`<h${level}>${inline(heading[2], options)}</h${level}>`);
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((unordered ?? ordered)![1]);
      index += 1;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      const quoted: string[] = [quote[1]];
      index += 1;
      while (index < lines.length) {
        const next = lines[index].match(/^>\s?(.*)$/);
        if (!next) break;
        quoted.push(next[1]);
        index += 1;
      }
      out.push(`<blockquote>${inline(quoted.join("\n"), options)}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      index += 1;
      continue;
    }

    if (list) {
      // Continuation line of the previous list item.
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  flushList();
  return out.join("");
}
