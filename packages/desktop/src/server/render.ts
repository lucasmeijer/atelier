import { escapeHtml, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { desktopAppKey } from "./runtime.ts";

export function renderDesktopWorkView(workspaceId: string): WorkspaceWorkViewPresentation {
  return {
    sourceKey: desktopAppKey,
    label: "Desktop",
    reference: { type: "desktop" },
    kind: "resource",
    availability: { phase: "live" },
    bodyHtml: `<section class="work-view-pane" data-work-view-source="${desktopAppKey}">${renderDesktopPane(workspaceId)}</section>`,
  };
}

function renderDesktopPane(workspaceId: string): string {
  const path = "/vnc.html?autoconnect=true&resize=remote&path=websockify";
  return `<div class="browser-pane desktop-pane">
    <div class="browser-shell">
      <div class="browser-toolbar work-view-toolbar"><div class="browser-window-controls" aria-hidden="true"><span class="red"></span><span class="amber"></span><span class="green"></span></div><span>Workspace Desktop</span></div>
      <div class="browser-viewport">
        <iframe data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-app-frame-app-key-value="${desktopAppKey}" data-workspace-app-frame-initial-path-value="${escapeHtml(path)}" title="Workspace desktop" loading="eager" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </div>`;
}
