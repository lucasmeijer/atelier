import { escapeHtml } from "./html.ts";

/**
 * Render-time rewriting of atelier:// references in assistant output.
 *
 * The agent is prompted to reference container-local resources as:
 *   atelier://file/<absolute path inside the container>   (images, videos, files)
 *   atelier://port/<port>[/path]                          (local dev servers)
 *
 * The session file keeps the agent's original text; we translate at render
 * time into URLs served/proxied by the web app.
 */

const fileToken = /atelier:\/\/file\/(\/[^\s)"'<>\]]*)/g;
const portToken = /atelier:\/\/port\/(\d+)((?:\/[^\s)"'<>\]]*)?)/g;

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

export function workspaceFileUrl(workspaceId: string, path: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-files?path=${encodeURIComponent(path)}`;
}

export function workspacePortUrl(workspaceId: string, port: number, path = "/"): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/agent-port/${port}${path.startsWith("/") ? path : `/${path}`}`;
}

export function containsAtelierToken(text: string): boolean {
  return text.includes("atelier://");
}

/**
 * Rewrites a raw text segment if it contains atelier:// tokens.
 * Returns undefined when there is nothing to rewrite (caller escapes normally).
 */
export function rewriteSegment(workspaceId: string, rawText: string): string | undefined {
  if (!containsAtelierToken(rawText)) return undefined;
  let html = escapeHtml(rawText);

  html = html.replace(fileToken, (_match, path: string) => {
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    const url = workspaceFileUrl(workspaceId, path);
    const name = path.split("/").pop() ?? path;
    if (imageExtensions.has(ext)) {
      return `</p><a class="agent-media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="agent-media-img" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy"></a><p>`;
    }
    if (videoExtensions.has(ext)) {
      return `</p><video class="agent-media-video" src="${escapeHtml(url)}" controls preload="metadata"></video><p>`;
    }
    return `<a class="agent-media-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
  });

  html = html.replace(portToken, (_match, port: string, path: string) => {
    const url = workspacePortUrl(workspaceId, Number(port), path || "/");
    return `</p><div class="agent-media-frame"><div class="agent-media-frame-bar"><span>localhost:${escapeHtml(port)}${escapeHtml(path || "/")}</span><a href="${escapeHtml(url)}" target="_blank" rel="noopener">open ↗</a></div><iframe src="${escapeHtml(url)}" loading="lazy"></iframe></div><p>`;
  });

  return html;
}

export const atelierMediaPromptInstructions = `To show the user an image, video, or other file from the workspace, reference it on its own line as atelier://file/<absolute path>, for example: atelier://file//repos/shots/out.png (note: always the absolute container path). The web UI renders these inline: images become <img>, videos get a player with seeking, other files become download links.
When you started a local dev server on some port and want the user to try it, write atelier://port/<port> (optionally atelier://port/<port>/some/path) on its own line and it will be shown as an embedded live preview.`;
