import { domId, escapeHtml } from "./util.ts";

export function vscodeTabKey(title: string): string {
  return `vscode:${title}`;
}

export function renderVSCodePane(workspaceId: string, title: string): string {
  const key = vscodeTabKey(title);
  const escapedWorkspaceId = escapeHtml(workspaceId);
  return `<div id="${domId("vscode_pane", workspaceId, title)}" class="tab-pane vscode-pane" data-tab-pane="${escapeHtml(key)}">
    <iframe class="vscode-frame" data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapedWorkspaceId}" data-workspace-app-frame-app-key-value="vscode" allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen title="VS Code"></iframe>
  </div>`;
}
