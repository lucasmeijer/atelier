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

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

function workspaceFileUrl(workspaceId: string, path: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-files?path=${encodeURIComponent(path)}`;
}

function workspacePortUrl(workspaceId: string, port: number, path = "/"): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-port/${port}${path.startsWith("/") ? path : `/${path}`}`;
}

export function containsAtelierEmbed(text: string): boolean {
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
  const url = workspaceFileUrl(workspaceId, path);
  const name = path.split("/").pop() || path;

  if (imageExtensions.has(ext)) {
    return `</p><a class="agent-media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="agent-media-img" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy"></a><p>`;
  }
  if (videoExtensions.has(ext)) {
    return `</p><video class="agent-media-video" src="${escapeHtml(url)}" controls preload="metadata"></video><p>`;
  }
  return `<a class="agent-media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
}

function renderUrlEmbed(workspaceId: string, rawTarget: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawTarget);
  } catch {
    return escapeHtml(`{{atelier:embed ${rawTarget}}}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return escapeHtml(`{{atelier:embed ${rawTarget}}}`);

  let src = parsed.toString();
  if (isLoopbackHost(parsed.hostname)) {
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    src = workspacePortUrl(workspaceId, port, `${parsed.pathname}${parsed.search}`);
  }

  return `</p><div class="agent-media-frame"><div class="agent-media-frame-bar"><span>${escapeHtml(rawTarget)}</span><a href="${escapeHtml(src)}" target="_blank" rel="noopener">open ↗</a></div><iframe src="${escapeHtml(src)}" loading="lazy"></iframe></div><p>`;
}

function renderEmbed(workspaceId: string, rawTarget: string): string {
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
    html += renderEmbed(workspaceId, match[1] ?? "");
    cursor = index + match[0].length;
  }
  html += escapeHtml(rawText.slice(cursor));
  return html;
}

export const atelierMediaPromptInstructions = `To show the user workspace media or an app preview, use an explicit Atelier embed directive:

{{atelier:embed <target>}}

Use this only when you want the web UI to render the target inline. The target must be either:
- an absolute path inside the workspace container, e.g. {{atelier:embed /repos/app/screenshot.png}}
- an http(s) URL, e.g. {{atelier:embed http://localhost:3000/dashboard}}

Image-looking files render as images, video-looking files render with a video player, other files render as links, and URLs render as preview iframes. The directive can appear in the middle of a sentence, but do not wrap it in Markdown link or image syntax. Do not use it for ordinary code/path mentions.`;
