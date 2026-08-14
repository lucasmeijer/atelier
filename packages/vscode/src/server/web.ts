import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { renderVSCodePane, vscodeTabKey } from "./render.ts";
import { createWorkspaceVSCodeTab, deleteWorkspaceVSCodeState, deleteWorkspaceVSCodeTab, listWorkspaceVSCodeTabs, type WorkspaceVSCodeTab } from "./workspace-vscode.ts";
import { vscodeStaticFiles } from "./static.ts";
import { deleteWorkspaceVSCodeProxyState, patchVSCodeWorkspaceAppResponse, resolveVSCodeWorkspaceAppTarget, vscodeAppKey } from "./proxy.ts";

export function renderWorkspaceVSCodeTabs(workspaceId: string, tabs: WorkspaceVSCodeTab[]): WorkspaceTabContribution[] {
  return tabs.map((tab) => ({
    key: vscodeTabKey(tab.title),
    label: tab.title,
    paneHtml: renderVSCodePane(workspaceId, tab.title),
    workView: { reference: { type: "vscode", title: tab.title }, kind: "resource", availability: { phase: "live" } },
  }));
}

function parseVSCodeReference(value: unknown): { type: "vscode"; title: string } {
  const reference = value as { type?: unknown; title?: unknown };
  if (reference?.type !== "vscode" || typeof reference.title !== "string" || !reference.title.trim()) throw new Error("title is required");
  return { type: "vscode", title: reference.title };
}

export const vscodeWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "vscode.open",
    label: "Open VS Code",
    scope: "workspace",
    surfaces: {
      ui: { placement: "group-menu", label: "New VS Code" },
      shortcut: { defaultBinding: "Meta+Alt+KeyV" },
    },
  },
];

export const vscodeWorkspaceModule: WorkspaceModule = {
  id: "vscode",
  workViews: [{
    type: "vscode",
    parseReference: parseVSCodeReference,
    identity: (reference: { type: "vscode"; title: string }) => reference.title,
    close: ({ workspaceId, reference }: { workspaceId: string; reference: { type: "vscode"; title: string } }) => deleteWorkspaceVSCodeTab(workspaceId, reference.title),
  }],
  staticFiles: vscodeStaticFiles,
  initialize(context) {
    context.registerWorkspaceAppHandler({
      matches: (app) => app.appKey === vscodeAppKey,
      resolveTarget: (app, requestUrl) => resolveVSCodeWorkspaceAppTarget(app, requestUrl),
      transformResponse: (app, response, request) => patchVSCodeWorkspaceAppResponse(app, response, request),
    });
    context.onWorkspaceRemoved((workspaceId) => {
      deleteWorkspaceVSCodeState(workspaceId);
      deleteWorkspaceVSCodeProxyState(workspaceId);
    });
  },
  commands: [{
    id: "vscode.open",
    async execute({ workspaceId, tabKeys }) {
      const existing = (await tabKeys()).find((key) => key.startsWith("vscode:"));
      return { createdTabKey: existing ?? vscodeTabKey(createWorkspaceVSCodeTab(workspaceId).title), tabPlacement: "preview-group" };
    },
  }],
  tabs: [{
    owns: (tabKey) => tabKey.startsWith("vscode:"),
    close: ({ workspaceId, tabKey }) => deleteWorkspaceVSCodeTab(workspaceId, tabKey.slice("vscode:".length)),
  }],
  attachToWorkspace({ workspaceId }) {
    return {
      tabs: renderWorkspaceVSCodeTabs(workspaceId, listWorkspaceVSCodeTabs(workspaceId)),
      commands: vscodeWorkspaceCommands,
    };
  },
};

export { createWorkspaceVSCodeTab };
