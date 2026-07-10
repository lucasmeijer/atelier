import { domId, escapeHtml } from "@atelier/shared";

export function vscodeTabKey(title: string): string {
  return `vscode:${title}`;
}

export function renderVSCodePane(workspaceId: string, title: string): string {
  const key = vscodeTabKey(title);
  const escapedWorkspaceId = escapeHtml(workspaceId);
  return `<div id="${domId("vscode_pane", workspaceId, title)}" class="tab-pane vscode-pane" data-tab-pane="${escapeHtml(key)}">
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
