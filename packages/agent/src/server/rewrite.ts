import { workspaceFileEditorOpenUrl } from "@atelier/editor/server";
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

function renderFullscreenFrame(title: string, iframeHtml: string, newTabLinkHtml: string): string {
  return `<div class="agent-media-frame" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="media" data-atelier-fullscreen-title-value="${escapeHtml(title)}"><div class="agent-media-frame-bar"><span>${escapeHtml(title)}</span><div class="agent-media-frame-actions"><button class="agent-media-frame-action" type="button" data-action="atelier-fullscreen#open"><span class="agent-shortcut">f</span>ullscreen</button><span class="agent-media-frame-sep" aria-hidden="true">–</span>${newTabLinkHtml}</div></div>${iframeHtml}</div>`;
}

function renderFileEmbed(workspaceId: string, path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) return escapeHtml(`{{atelier:embed ${path}}}`);

  const ext = extensionOf(path);
  const name = path.split("/").pop() || path;
  const proxy = workspaceProxyController(workspaceId, "file", path);

  if (imageExtensions.has(ext)) {
    return `<a class="agent-media-link" ${proxy} target="_blank" rel="noopener"><img class="agent-media-img" data-controller="agent-proxy atelier-fullscreen" data-atelier-fullscreen-mode-value="media" data-atelier-fullscreen-title-value="${escapeHtml(name)}" data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-agent-proxy-app-key-value="file" data-agent-proxy-path-value="${escapeHtml(path)}" alt="${escapeHtml(name)}" loading="lazy"></a>`;
  }
  if (videoExtensions.has(ext)) {
    return `<video class="agent-media-video" data-controller="agent-proxy atelier-fullscreen" data-atelier-fullscreen-mode-value="media" data-atelier-fullscreen-title-value="${escapeHtml(name)}" data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-agent-proxy-app-key-value="file" data-agent-proxy-path-value="${escapeHtml(path)}" controls preload="metadata"></video>`;
  }
  if (ext === "html" || ext === "htm") {
    const iframe = `<iframe data-controller="agent-proxy agent-html-preview" data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-agent-proxy-app-key-value="file" data-agent-proxy-path-value="${escapeHtml(path)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`;
    return renderFullscreenFrame(path, iframe, `<a ${proxy} target="_blank" rel="noopener">in new tab ↗</a>`);
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
    const iframe = `<iframe data-controller="agent-proxy agent-html-preview" data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}" data-agent-proxy-app-key-value="${escapeHtml(appKey)}" data-agent-proxy-path-value="${escapeHtml(path)}" loading="lazy"></iframe>`;
    return renderFullscreenFrame(rawTarget, iframe, `<a ${proxy} target="_blank" rel="noopener">in new tab ↗</a>`);
  }

  const src = parsed.toString();
  return renderFullscreenFrame(rawTarget, `<iframe src="${escapeHtml(src)}" loading="lazy"></iframe>`, `<a href="${escapeHtml(src)}" target="_blank" rel="noopener">in new tab ↗</a>`);
}

function renderAtelierLinkLabel(label: string): string {
  return label
    .split(/(`[^`]*`)/)
    .map((part) => part.startsWith("`") && part.endsWith("`")
      ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
      : escapeHtml(part))
    .join("");
}

export function renderAtelierFileLink(workspaceId: string, label: string, rawHref: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawHref);
  } catch {
    return undefined;
  }
  if (url.protocol !== "atelier:" || url.hostname !== "file") return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const position: { line?: number; column?: number } = {};
  for (const name of ["line", "column"] as const) {
    const value = url.searchParams.get(name);
    if (value && /^\d+$/.test(value)) position[name] = Number(value);
  }
  const href = workspaceFileEditorOpenUrl(workspaceId, path, position);
  return `<a href="${escapeHtml(href)}" data-turbo-stream="true">${renderAtelierLinkLabel(label)}</a>`;
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
