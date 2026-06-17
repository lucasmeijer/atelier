import type { WorkspaceTabContribution } from "@atelier/shared";
import { desktopAppKey, desktopTabKey } from "./runtime.ts";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDesktopTab(workspaceId: string): WorkspaceTabContribution {
  return {
    key: desktopTabKey,
    label: "Desktop",
    paneHtml: `<section class="tab-pane" data-tab-pane="${desktopTabKey}">${renderDesktopPane(workspaceId)}</section>`,
  };
}

function renderDesktopPane(workspaceId: string): string {
  const path = "/vnc.html?autoconnect=true&resize=remote&path=websockify";
  return `<div class="browser-pane desktop-pane">
    <div class="browser-shell">
      <div class="browser-toolbar"><div class="browser-window-controls" aria-hidden="true"><span class="red"></span><span class="amber"></span><span class="green"></span></div><span>Workspace Desktop</span></div>
      <div class="browser-viewport">
        <iframe data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-app-frame-app-key-value="${desktopAppKey}" data-workspace-app-frame-initial-path-value="${escapeHtml(path)}" title="Workspace desktop" loading="eager" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </div>`;
}
