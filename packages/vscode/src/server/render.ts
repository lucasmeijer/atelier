import { randomUUID } from "node:crypto";
import { domId, escapeHtml, turboStream, type WorkspaceFileTarget } from "@atelier/shared";

export function vscodeViewKey(title: string): string {
  return `vscode:${title}`;
}

export function renderVSCodePane(workspaceId: string, title: string): string {
  const key = vscodeViewKey(title);
  const escapedWorkspaceId = escapeHtml(workspaceId);
  return `<div id="${domId("vscode_pane", workspaceId, title)}" class="vscode-work-view" data-work-view-source="${escapeHtml(key)}">
    <div class="vscode-frame-shell vscode-loading">
      <iframe class="vscode-frame" data-controller="workspace-app-frame vscode-starting" data-workspace-app-frame-workspace-id-value="${escapedWorkspaceId}" data-workspace-app-frame-app-key-value="vscode" allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen title="VS Code"></iframe>
      <div class="vscode-starting-screen" aria-live="polite">
        <div class="vscode-starting-card">
          <span class="status-spinner vscode-starting-spinner" aria-hidden="true"></span>
          <div>
            <div class="vscode-starting-title">Starting VS Code</div>
            <div class="vscode-starting-subtitle">Preparing the editor for this workspace…</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

export function renderVSCodeNavigationSignal(workspaceId: string): string {
  return `<span id="${domId("vscode_navigation", workspaceId)}" hidden></span>`;
}

export function vscodeFileNavigationStream(workspaceId: string, title: string, target: WorkspaceFileTarget): string {
  const line = target.line ?? (target.column ? 1 : undefined);
  const query = new URLSearchParams({
    atelierOpenFile: line ? `${target.path}:${line}:${target.column ?? 1}` : target.path,
    // Repeated links must still navigate after the user switches files inside VS Code.
    atelierNavigation: randomUUID(),
  });
  if (line) query.set("atelierGotoLine", "1");
  return turboStream("update", domId("vscode_navigation", workspaceId),
    `<span data-controller="vscode-navigate" data-vscode-navigate-pane-id-value="${domId("vscode_pane", workspaceId, title)}" data-vscode-navigate-path-value="${escapeHtml(`/?${query}`)}"></span>`);
}
