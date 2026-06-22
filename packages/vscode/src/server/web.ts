import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { renderVSCodePane, vscodeTabKey } from "./render.ts";
import { createWorkspaceVSCodeTab, deleteWorkspaceVSCodeTab, listWorkspaceVSCodeTabs, type WorkspaceVSCodeTab } from "./workspace-vscode.ts";
import { vscodeStaticFiles } from "./static.ts";

export function renderWorkspaceVSCodeTabs(workspaceId: string, tabs: WorkspaceVSCodeTab[]): WorkspaceTabContribution[] {
  return tabs.map((tab) => ({
    key: vscodeTabKey(tab.title),
    label: tab.title,
    paneHtml: renderVSCodePane(workspaceId, tab.title),
  }));
}

export const vscodeWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "vscode.open",
    label: "Open VS Code",
    surfaces: {
      ui: { placement: "group-menu", label: "New VS Code" },
      shortcut: { defaultBinding: "Meta+Alt+KeyV" },
    },
  },
];

export const vscodeWorkspaceModule: WorkspaceModule = {
  id: "vscode",
  staticFiles: vscodeStaticFiles,
  commands: [{
    id: "vscode.open",
    async execute({ workspaceId, tabKeys }) {
      const existing = (await tabKeys()).find((key) => key.startsWith("vscode:"));
      return { createdTabKey: existing ?? vscodeTabKey(createWorkspaceVSCodeTab(workspaceId).title) };
    },
  }],
  tabs: [{
    owns: (tabKey) => tabKey.startsWith("vscode:"),
    close: ({ workspaceId, tabKey }) => deleteWorkspaceVSCodeTab(workspaceId, tabKey.slice("vscode:".length)),
  }],
  attachToWorkspace({ workspaceId }) {
    return {
      tabs: renderWorkspaceVSCodeTabs(workspaceId, listWorkspaceVSCodeTabs(workspaceId)),
      workspaceCommands: vscodeWorkspaceCommands,
    };
  },
};

export { createWorkspaceVSCodeTab };
