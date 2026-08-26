import { escapeHtml, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { browserFrameId, type WorkspaceBrowserView } from "./state.ts";
import { browserProxyUrl } from "../shared.ts";

export function renderBrowserWorkView(workspaceId: string, view: WorkspaceBrowserView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: view.key,
    label: view.label,
    reference: { type: "browser", browserId: view.key },
    kind: "resource",
    availability: { phase: "live" },
    bodyHtml: `<section class="work-view-pane" data-work-view-source="${escapeHtml(view.key)}">${renderBrowserPane(workspaceId, view)}</section>`,
  };
}

export function renderBrowserPane(workspaceId: string, view: WorkspaceBrowserView): string {
  return `<div class="browser-pane">
    ${renderBrowserFrame(workspaceId, view)}
  </div>`;
}

export function renderBrowserFrame(workspaceId: string, view: WorkspaceBrowserView): string {
  const target = view.targetUrl ? new URL(view.targetUrl) : undefined;
  const proxy = target ? browserProxyUrl(target, "http://atelier.browser") : undefined;
  const initialPath = proxy ? `${proxy.pathname}${proxy.search}${proxy.hash}` : "";
  const appKey = view.key;
  const frameControllerAttributes = target ? ` data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-app-frame-app-key-value="${escapeHtml(appKey)}" data-workspace-app-frame-initial-path-value="${escapeHtml(initialPath)}"` : "";
  const externalLinkAttributes = target ? ` href="#"` : ` aria-disabled="true"`;
  return `<turbo-frame id="${browserFrameId(workspaceId, appKey)}" class="browser-frame">
    <div class="browser-shell">
      <form class="browser-toolbar" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/browser/${encodeURIComponent(appKey)}/navigate" data-turbo-frame="${browserFrameId(workspaceId, appKey)}" data-controller="browser-address" data-action="submit->browser-address#submit">
        <div class="browser-window-controls" aria-hidden="true"><span class="red"></span><span class="amber"></span><span class="green"></span></div>
        <button class="browser-nav-button" type="button" data-action="browser-address#back" title="Back" aria-label="Back">←</button>
        <button class="browser-nav-button" type="button" data-action="browser-address#forward" title="Forward" aria-label="Forward">→</button>
        <button class="browser-nav-button" type="button" data-action="browser-address#reload" title="Reload" aria-label="Reload">↻</button>
        <input class="browser-address-input" name="url" value="${escapeHtml(view.targetUrl)}" placeholder="http://localhost:3000/" spellcheck="false" autocomplete="off" aria-label="Browser URL">
        <a class="browser-open-external"${externalLinkAttributes} data-browser-address-target="external" target="_blank" rel="noreferrer" title="Open preview in a new view">↗</a>
      </form>
      <div class="browser-viewport">
        <iframe${frameControllerAttributes} title="Workspace browser preview" loading="eager" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </turbo-frame>`;
}
