import { escapeHtml, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { browserFrameId, type WorkspaceBrowserTab } from "./state.ts";

export function renderBrowserWorkView(workspaceId: string, tab: WorkspaceBrowserTab): WorkspaceWorkViewPresentation {
  return {
    sourceKey: tab.key,
    label: tab.label,
    reference: { type: "browser", browserId: tab.key },
    kind: "resource",
    availability: { phase: "live" },
    bodyHtml: `<section class="work-view-pane" data-work-view-source="${escapeHtml(tab.key)}">${renderBrowserPane(workspaceId, tab)}</section>`,
  };
}

export function renderBrowserPane(workspaceId: string, tab: WorkspaceBrowserTab): string {
  return `<div class="browser-pane">
    ${renderBrowserFrame(workspaceId, tab)}
  </div>`;
}

export function renderBrowserFrame(workspaceId: string, tab: WorkspaceBrowserTab): string {
  const target = tab.targetUrl ? new URL(tab.targetUrl) : undefined;
  const initialPath = target ? `${target.pathname}${target.search}${target.hash}` : "";
  const targetOrigin = target?.origin ?? "";
  const appKey = tab.key;
  const frameControllerAttributes = target ? ` data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-app-frame-app-key-value="${escapeHtml(appKey)}" data-workspace-app-frame-initial-path-value="${escapeHtml(initialPath)}"` : "";
  const externalLinkAttributes = target ? ` href="#"` : ` aria-disabled="true"`;
  return `<turbo-frame id="${browserFrameId(workspaceId, appKey)}" class="browser-frame">
    <div class="browser-shell">
      <form class="browser-toolbar" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/browser/${encodeURIComponent(appKey)}/navigate" data-turbo-frame="${browserFrameId(workspaceId, appKey)}" data-controller="browser-address" data-browser-address-target-origin-value="${escapeHtml(targetOrigin)}" data-action="submit->browser-address#submit">
        <div class="browser-window-controls" aria-hidden="true"><span class="red"></span><span class="amber"></span><span class="green"></span></div>
        <button class="browser-nav-button" type="button" data-action="browser-address#back" title="Back" aria-label="Back">←</button>
        <button class="browser-nav-button" type="button" data-action="browser-address#forward" title="Forward" aria-label="Forward">→</button>
        <button class="browser-nav-button" type="button" data-action="browser-address#reload" title="Reload" aria-label="Reload">↻</button>
        <input class="browser-address-input" name="url" value="${escapeHtml(tab.targetUrl)}" placeholder="http://localhost:3000/" spellcheck="false" autocomplete="off" aria-label="Browser URL">
        <a class="browser-open-external"${externalLinkAttributes} data-browser-address-target="external" target="_blank" rel="noreferrer" title="Open preview in a new tab">↗</a>
      </form>
      <div class="browser-viewport">
        <iframe${frameControllerAttributes} title="Workspace browser preview" loading="eager" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </turbo-frame>`;
}
