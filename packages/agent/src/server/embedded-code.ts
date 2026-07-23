import { format as formatJavaScript } from "@wasm-fmt/biome_fmt";
import { format as formatPython } from "@wasm-fmt/ruff_fmt";
import { highlightCodeHtmlForPath, languageFromPath } from "./highlight.ts";
import { escapeHtml } from "./html.ts";

interface BashHeredoc {
  path: string;
  contentStart: number;
  contentEnd: number;
}

const bashHeredocOpening = /(?:^|[;&|]\s*|[({]\s*|\bthen\s+)(?:cat\s+>{1,2}\s*("[^"\n]+"|'[^'\n]+'|[^\s;|&]+)|(?:timeout\s+[^\s;&|<]+\s+)?(bun|node|python3?)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&<]+))*)\s*<<(-?)\s*('[^'\n]+'|"[^"\n]+"|[A-Za-z_][\w-]*)/gm;

function unquoteShellWord(word: string): string {
  const quote = word[0];
  return quote && (quote === "'" || quote === '"') && word.at(-1) === quote ? word.slice(1, -1) : word;
}

function heredocProgramPath(program: string, delimiter: string): string {
  if (program.startsWith("python")) return "stdin.py";
  if (program === "bun" && /^(?:ts|typescript)$/i.test(delimiter)) return "stdin.ts";
  return "stdin.js";
}

function bashHeredocs(command: string): BashHeredoc[] {
  const heredocs: BashHeredoc[] = [];
  bashHeredocOpening.lastIndex = 0;
  for (;;) {
    const opening = bashHeredocOpening.exec(command);
    if (!opening) break;
    const openingLineEnd = command.indexOf("\n", opening.index + opening[0].length);
    if (openingLineEnd < 0) break;
    const delimiter = unquoteShellWord(opening[4]!);
    const stripsTabs = opening[3] === "-";
    let closingStart = openingLineEnd + 1;
    let closingEnd = closingStart;
    for (;;) {
      closingEnd = command.indexOf("\n", closingStart);
      if (closingEnd < 0) closingEnd = command.length;
      const line = command.slice(closingStart, closingEnd).replace(/\r$/, "");
      if ((stripsTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      if (closingEnd === command.length) {
        closingStart = -1;
        break;
      }
      closingStart = closingEnd + 1;
    }
    if (closingStart < 0) continue;
    const contentStart = openingLineEnd + 1;
    const path = opening[1] ? unquoteShellWord(opening[1]) : heredocProgramPath(opening[2]!, delimiter);
    heredocs.push({ path, contentStart, contentEnd: Math.max(contentStart, closingStart - 1) });
    bashHeredocOpening.lastIndex = closingEnd;
  }
  return heredocs;
}

function displayFormattedFile(content: string, path: string): string | undefined {
  const language = languageFromPath(path);
  try {
    let formatted: string;
    switch (language) {
      case "javascript":
      case "typescript":
        formatted = formatJavaScript(content, path, { indentStyle: "space", indentWidth: 2 });
        break;
      case "python":
        formatted = formatPython(content, path, { indent_style: "space", indent_width: 4 });
        break;
      case "json":
        formatted = JSON.stringify(JSON.parse(content), null, 2);
        break;
      default:
        return undefined;
    }
    const trimmed = formatted.trimEnd();
    if (trimmed === content.trimEnd()) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

export function formatBashCommandForDisplay(command: string): string {
  let formatted = "";
  let quote: "'" | '"' | "`" | undefined;
  let inComment = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;

    if (inComment) {
      formatted += character;
      if (character === "\n") inComment = false;
      continue;
    }

    if (quote) {
      formatted += character;
      if (character === "\\" && quote !== "'" && index + 1 < command.length) {
        formatted += command[++index];
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "\\" && index + 1 < command.length) {
      formatted += character + command[++index];
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      formatted += character;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]!))) {
      inComment = true;
      formatted += character;
      continue;
    }
    if (character !== "|" || command[index - 1] === "|" || command[index + 1] === "|") {
      formatted += character;
      continue;
    }

    formatted += character;
    if (command[index + 1] === "&") formatted += command[++index];
    while (command[index + 1] === " " || command[index + 1] === "\t") index++;
    if (command[index + 1] === "\r" && command[index + 2] === "\n") index += 2;
    else if (command[index + 1] === "\n") index++;
    formatted += "\n";
  }

  return formatted;
}

function highlightedBashShell(command: string): string {
  return highlightCodeHtmlForPath(formatBashCommandForDisplay(command), "command.sh").html;
}

export function embeddedBashCommandHtml(command: string): string | undefined {
  const heredocs = bashHeredocs(command);
  if (!heredocs.length) return undefined;
  let html = "";
  let cursor = 0;
  for (const heredoc of heredocs) {
    html += highlightedBashShell(command.slice(cursor, heredoc.contentStart));
    const originalContent = command.slice(heredoc.contentStart, heredoc.contentEnd);
    const formattedContent = displayFormattedFile(originalContent, heredoc.path);
    const nested = highlightCodeHtmlForPath(formattedContent ?? originalContent, heredoc.path);
    const languageClass = nested.language ? ` class="language-${escapeHtml(nested.language)}"` : "";
    const formattedAttribute = formattedContent === undefined ? "" : " data-atelier-display-formatted";
    html += `<span${languageClass}${formattedAttribute}>${nested.html}</span>`;
    cursor = heredoc.contentEnd;
  }
  html += highlightedBashShell(command.slice(cursor));
  return `<pre class="agent-tool-code language-bash"><code>${html}</code></pre>`;
}
