import { escapeHtml } from "./html.ts";
import { highlightCodeHtml } from "./highlight.ts";

/**
 * Minimal server-side markdown renderer for assistant messages.
 * Supports: headings, fenced code blocks, inline code, bold, italics, links,
 * unordered/ordered lists, blockquotes, tables, paragraphs.
 *
 * An optional `rewriteSegment` hook lets callers turn explicit embed directives
 * into HTML; it receives raw (unescaped) text segments outside of code
 * spans/blocks and returns HTML.
 */
interface MarkdownOptions {
  rewriteSegment?: (rawText: string) => string | undefined;
  rewriteLink?: (label: string, href: string) => string | undefined;
  highlightCode?: boolean;
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  let inCode = false;
  for (const character of value) {
    if (escaped) {
      cell += character === "|" ? "|" : `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "`") {
      inCode = !inCode;
      cell += character;
    } else if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

function parseTableHeader(header: string, delimiter: string): string[] | undefined {
  if (!header.includes("|")) return undefined;
  const cells = splitTableRow(header);
  const delimiters = splitTableRow(delimiter);
  if (cells.length !== delimiters.length || !delimiters.every((cell) => /^:?-{3,}:?$/.test(cell))) return undefined;
  return cells;
}

function inlineText(raw: string): string {
  let html = escapeHtml(raw);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html.replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

function inline(raw: string, options: MarkdownOptions): string {
  let html = "";
  let cursor = 0;
  const tokens = /`([^`]*)`|\[([^\]]+)\]\((atelier:\/\/[^\s)]+)\)/g;
  const renderText = (text: string) => text ? options.rewriteSegment?.(text) ?? inlineText(text) : "";

  for (const match of raw.matchAll(tokens)) {
    html += renderText(raw.slice(cursor, match.index));
    html += match[1] !== undefined
      ? `<code>${escapeHtml(match[1])}</code>`
      : options.rewriteLink?.(match[2]!, match[3]!) ?? inlineText(match[0]);
    cursor = match.index + match[0].length;
  }

  return html + renderText(raw.slice(cursor));
}

function tableRow(cells: string[], tag: "th" | "td", options: MarkdownOptions): string {
  return `<tr>${cells.map((cell) => `<${tag}>${inline(cell, options)}</${tag}>`).join("")}</tr>`;
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
      const label = rawLang ? `Copy ${escapeHtml(rawLang)} code to clipboard` : "Copy code to clipboard";
      out.push(`<div class="agent-code-block" data-controller="agent-code-copy"><button type="button" class="agent-code-copy" data-action="agent-code-copy#copy" aria-label="${label}" title="Copy code"><span class="agent-code-copy-icon" aria-hidden="true">⧉</span></button><pre${attrs ? ` ${attrs}` : ""}><code data-agent-code-copy-target="code">${highlighted.html}</code></pre></div>`);
      continue;
    }

    const header = index + 1 < lines.length ? parseTableHeader(line, lines[index + 1]) : undefined;
    if (header) {
      flushParagraph();
      flushList();
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        const cells = splitTableRow(lines[index]);
        if (cells.length !== header.length) break;
        rows.push(cells);
        index += 1;
      }
      out.push(`<div class="agent-table-scroll"><table><thead>${tableRow(header, "th", options)}</thead><tbody>${rows.map((row) => tableRow(row, "td", options)).join("")}</tbody></table></div>`);
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
      if (list) {
        let nextIndex = index + 1;
        while (nextIndex < lines.length && lines[nextIndex].trim() === "") nextIndex += 1;
        const nextLine = lines[nextIndex] ?? "";
        const nextIsUnordered = /^\s*[-*]\s+/.test(nextLine);
        const nextIsOrdered = /^\s*\d+[.)]\s+/.test(nextLine);
        if ((list.ordered && nextIsOrdered) || (!list.ordered && nextIsUnordered)) {
          index += 1;
          continue;
        }
      }
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
