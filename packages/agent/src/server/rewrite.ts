import { escapeHtml } from "./html.ts";

/**
 * Render-time rewriting of explicit Atelier embed directives in assistant output.
 *
 * The session file keeps the agent's original text; we translate only opt-in
 * directives of the form:
 *   {{atelier:embed /absolute/path/in/container}}
 *   {{atelier:embed http://localhost:3000/path}}
 */

const embedToken = /\{\{\s*atelier:embed\s+([^{}]+?)\s*\}\}/g;
const stickyEmbedToken = /\{\{\s*atelier:embed\s+([^{}]+?)\s*\}\}/y;

export type AtelierEmbedSegment =
  | { type: "text"; text: string }
  | { type: "embed"; target: string };

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

function workspaceProxyController(workspaceId: string, appKey: string, path: string): string {
  return [
    `data-controller="agent-proxy"`,
    `data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}"`,
    `data-agent-proxy-app-key-value="${escapeHtml(appKey)}"`,
    `data-agent-proxy-path-value="${escapeHtml(path)}"`,
  ].join(" ");
}

function containsAtelierEmbed(text: string): boolean {
  return text.includes("{{") && text.includes("atelier:embed");
}

function extensionOf(path: string): string {
  const name = path.split(/[?#]/)[0] ?? path;
  return (name.split(".").pop() ?? "").toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function renderFileEmbed(workspaceId: string, path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) return escapeHtml(`{{atelier:embed ${path}}}`);

  const ext = extensionOf(path);
  const name = path.split("/").pop() || path;
  const proxy = workspaceProxyController(workspaceId, "file", path);

  if (imageExtensions.has(ext)) {
    return `<a class="agent-media-link" ${proxy} target="_blank" rel="noopener"><img class="agent-media-img" ${proxy} alt="${escapeHtml(name)}" loading="lazy"></a>`;
  }
  if (videoExtensions.has(ext)) {
    return `<video class="agent-media-video" ${proxy} controls preload="metadata"></video>`;
  }
  if (ext === "html" || ext === "htm") {
    return `<div class="agent-media-frame"><div class="agent-media-frame-bar"><span>${escapeHtml(path)}</span><a ${proxy} target="_blank" rel="noopener">open ↗</a></div><iframe data-controller="agent-proxy agent-html-preview" data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-agent-proxy-app-key-value="file" data-agent-proxy-path-value="${escapeHtml(path)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>`;
  }
  return `<a class="agent-media-link" ${proxy} target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
}

function renderUrlEmbed(workspaceId: string, rawTarget: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawTarget);
  } catch {
    return escapeHtml(`{{atelier:embed ${rawTarget}}}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return escapeHtml(`{{atelier:embed ${rawTarget}}}`);

  if (isLoopbackHost(parsed.hostname)) {
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    const appKey = `port-${port}`;
    const path = `${parsed.pathname}${parsed.search}`;
    const proxy = workspaceProxyController(workspaceId, appKey, path);
    return `<div class="agent-media-frame"><div class="agent-media-frame-bar"><span>${escapeHtml(rawTarget)}</span><a ${proxy} target="_blank" rel="noopener">open ↗</a></div><iframe data-controller="agent-proxy agent-html-preview" data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-agent-proxy-app-key-value="${escapeHtml(appKey)}" data-agent-proxy-path-value="${escapeHtml(path)}" loading="lazy"></iframe></div>`;
  }

  const src = parsed.toString();
  return `<div class="agent-media-frame"><div class="agent-media-frame-bar"><span>${escapeHtml(rawTarget)}</span><a href="${escapeHtml(src)}" target="_blank" rel="noopener">open ↗</a></div><iframe src="${escapeHtml(src)}" loading="lazy"></iframe></div>`;
}

export function renderAtelierEmbed(workspaceId: string, rawTarget: string): string {
  const target = rawTarget.trim();
  if (target.startsWith("http://") || target.startsWith("https://")) return renderUrlEmbed(workspaceId, target);
  if (target.startsWith("/")) return renderFileEmbed(workspaceId, target);
  return escapeHtml(`{{atelier:embed ${target}}}`);
}

/**
 * Rewrites a raw text segment if it contains Atelier embed directives.
 * Returns undefined when there is nothing to rewrite (caller escapes normally).
 */
export function rewriteSegment(workspaceId: string, rawText: string): string | undefined {
  if (!containsAtelierEmbed(rawText)) return undefined;

  let html = "";
  let cursor = 0;
  for (const match of rawText.matchAll(embedToken)) {
    const index = match.index ?? 0;
    html += escapeHtml(rawText.slice(cursor, index));
    html += renderAtelierEmbed(workspaceId, match[1] ?? "");
    cursor = index + match[0].length;
  }
  html += escapeHtml(rawText.slice(cursor));
  return html;
}

export function splitAtelierEmbeds(text: string): AtelierEmbedSegment[] {
  if (!containsAtelierEmbed(text)) return [{ type: "text", text }];

  const segments: AtelierEmbedSegment[] = [];
  let cursor = 0;
  let index = 0;
  let lineStart = true;
  let inFence = false;
  let inInlineCode = false;

  const pushText = (end: number) => {
    if (end > cursor) segments.push({ type: "text", text: text.slice(cursor, end) });
  };

  while (index < text.length) {
    if (lineStart && text.startsWith("```", index)) inFence = !inFence;

    if (!inFence && text[index] === "`") {
      inInlineCode = !inInlineCode;
      lineStart = false;
      index += 1;
      continue;
    }

    if (!inFence && !inInlineCode && text.startsWith("{{", index)) {
      stickyEmbedToken.lastIndex = index;
      const match = stickyEmbedToken.exec(text);
      if (match) {
        pushText(index);
        segments.push({ type: "embed", target: match[1] ?? "" });
        index = stickyEmbedToken.lastIndex;
        cursor = index;
        lineStart = false;
        continue;
      }
    }

    const char = text[index];
    lineStart = char === "\n";
    index += 1;
  }

  pushText(text.length);
  return segments.length > 0 ? segments : [{ type: "text", text }];
}

const atelierMediaPromptInstructions = `To show the user workspace media or an app preview, use an explicit Atelier embed directive:

{{atelier:embed <target>}}

Use this only when you want the web UI to render the target inline. The target must be either:
- an absolute path inside the workspace container, e.g. {{atelier:embed /work/app/screenshot.png}}
- an http(s) URL, e.g. {{atelier:embed http://localhost:3000/dashboard}}

Image-looking files render as images, video-looking files render with a video player, HTML files render as preview iframes, other files render as links, and URLs render as preview iframes. The directive can appear in the middle of a sentence, but do not wrap it in Markdown link or image syntax. Do not use it for ordinary code/path mentions.`;
