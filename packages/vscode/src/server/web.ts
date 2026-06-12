import type { WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { renderVSCodePane, vscodeTabKey } from "./render.ts";
import { createWorkspaceVSCodeTab, listWorkspaceVSCodeTabs, type WorkspaceVSCodeTab } from "./workspace-vscode.ts";
import { vscodeStaticFiles } from "./static.ts";

export function renderWorkspaceVSCodeTabs(workspaceId: string, tabs: WorkspaceVSCodeTab[]): WorkspaceTabContribution[] {
  return tabs.map((tab) => ({
    key: vscodeTabKey(tab.title),
    label: tab.title,
    paneHtml: renderVSCodePane(workspaceId, tab.title),
  }));
}

export const vscodeWorkspaceModule: WorkspaceModule = {
  id: "vscode",
  staticFiles: vscodeStaticFiles,
  attachToWorkspace({ workspaceId }) {
    return {
      tabs: renderWorkspaceVSCodeTabs(workspaceId, listWorkspaceVSCodeTabs(workspaceId)),
      tabActions: [{ key: "vscode:create", label: "New VS Code" }],
    };
  },
};

export { createWorkspaceVSCodeTab };
