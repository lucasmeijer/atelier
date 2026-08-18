import { escapeHtml, workspaceFileEditorOpenUrl } from "@atelier/shared";

/** Render Atelier-specific links and previews found in parsed Markdown. */

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

interface AtelierFilePosition {
  line?: number;
  column?: number;
}

function workspaceProxyController(workspaceId: string, appKey: string, path: string): string {
  return [
    `data-controller="agent-proxy"`,
    `data-agent-proxy-workspace-id-value="${escapeHtml(workspaceId)}"`,
    `data-agent-proxy-app-key-value="${escapeHtml(appKey)}"`,
    `data-agent-proxy-path-value="${escapeHtml(path)}"`,
  ].join(" ");
}

function extensionOf(path: string): string {
  return path.split(/[?#]/)[0]!.split(".").at(-1)!.toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function renderFullscreenFrame(title: string, iframeHtml: string, newTabLinkHtml: string): string {
  return `<span class="agent-media-frame" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="media" data-atelier-fullscreen-title-value="${escapeHtml(title)}"><span class="agent-media-frame-bar"><span>${escapeHtml(title)}</span><span class="agent-media-frame-actions"><button class="agent-media-frame-action" type="button" data-action="atelier-fullscreen#open"><span class="agent-shortcut">f</span>ullscreen</button><span class="agent-media-frame-sep" aria-hidden="true">–</span>${newTabLinkHtml}</span></span>${iframeHtml}</span>`;
}

function embedLiteral(target: string): string {
  return escapeHtml(`![](atelier-embed:${target})`);
}

function renderFileEmbed(workspaceId: string, path: string): string {
  if (path.includes("\0")) return embedLiteral(path);

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
    return embedLiteral(rawTarget);
  }

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

export function atelierFileEditorHref(workspaceId: string, rawHref: string): string | undefined {
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
  const position: AtelierFilePosition = {};
  for (const name of ["line", "column"] as const) {
    const value = url.searchParams.get(name);
    if (value && /^\d+$/.test(value)) position[name] = Number(value);
  }
  return workspaceFileEditorOpenUrl(workspaceId, path, position);
}

export function renderAtelierEmbed(workspaceId: string, rawTarget: string): string {
  let target: string;
  try {
    target = decodeURI(rawTarget.trim());
  } catch {
    return embedLiteral(rawTarget);
  }
  if (target.startsWith("http://") || target.startsWith("https://")) return renderUrlEmbed(workspaceId, target);
  if (target.startsWith("/")) return renderFileEmbed(workspaceId, target);
  return embedLiteral(target);
}
