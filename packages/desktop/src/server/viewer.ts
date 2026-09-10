import { escapeHtml } from "@atelier/shared";
import { inlineDesignSystemCss } from "@atelier/design-system/styles/server";
import type { DesktopStatus } from "./runtime.ts";

let assets: Promise<{ script: string; css: string }> | undefined;

// The viewer lives on its workspace ingress origin, not Atelier's UI origin.
// Bundle once per server process so noVNC and Stimulus need no CDN or workspace install.
function viewerAssets() {
  return assets ??= (async () => {
    const build = await Bun.build({ entrypoints: [new URL("../client/viewer.ts", import.meta.url).pathname], target: "browser", format: "esm", minify: true });
    if (!build.success) throw new AggregateError(build.logs, "Could not build desktop viewer");
    return {
      script: await build.outputs[0]!.text(),
      css: `${await inlineDesignSystemCss()}\n${await Bun.file(new URL("../client/viewer.css", import.meta.url)).text()}`,
    };
  })();
}

function renderDesktopStatus(status: DesktopStatus): string {
  const label = status.phase === "running" ? "Connecting" : status.phase === "starting" ? "Starting desktop" : status.phase === "failed" ? "Desktop failed" : "Desktop stopped";
  const detail = status.phase === "failed" ? status.error : status.phase === "stopped" ? "Open Desktop from the Work menu to start it." : "";
  return `<div data-phase="${status.phase}"><span class="desktop-status-label"><i class="status-dot ${status.phase === "failed" ? "danger" : status.phase === "stopped" ? "" : "running"}" aria-hidden="true"></i>${label}</span>${detail ? `<span class="desktop-status-detail">${escapeHtml(detail)}</span>` : ""}</div>`;
}

export async function desktopViewerResponse(url: URL, status: () => Promise<DesktopStatus>): Promise<Response> {
  const path = url.pathname;
  const headers = { "cache-control": "no-store" };
  if (path === "/status") return new Response(renderDesktopStatus(await status()), { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  if (path === "/desktop-client.js") return new Response((await viewerAssets()).script, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
  if (path !== "/") return new Response("Not found", { status: 404 });
  const current = await status();
  return new Response(`<!doctype html><html lang="en" data-theme="${escapeHtml(url.searchParams.get("theme") ?? "")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Desktop</title><style>${(await viewerAssets()).css}</style><script type="module" src="/desktop-client.js"></script></head>
<body data-controller="desktop" data-action="pagehide@window->desktop#disconnect message@window->desktop#receive">
  <div data-desktop-target="runtime" hidden>${renderDesktopStatus(current)}</div>
  <div class="desktop-screen" data-desktop-target="screen" aria-label="Workspace desktop"></div>
</body></html>`, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}
