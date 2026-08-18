import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceWorkViewPresentation, WorkspaceWorkViewReference } from "@atelier/shared";
import { renderVSCodePane, vscodeTabKey } from "./render.ts";
import { createWorkspaceVSCodeTab, deleteWorkspaceVSCodeState, deleteWorkspaceVSCodeTab, listWorkspaceVSCodeTabs, type WorkspaceVSCodeTab } from "./workspace-vscode.ts";
import { vscodeStaticFiles } from "./static.ts";
import { deleteWorkspaceVSCodeProxyState, patchVSCodeWorkspaceAppResponse, resolveVSCodeWorkspaceAppTarget, vscodeAppKey } from "./proxy.ts";

export function renderWorkspaceVSCodeWorkViews(workspaceId: string, views: WorkspaceVSCodeTab[]): WorkspaceWorkViewPresentation[] {
  return views.map((view) => ({
    sourceKey: vscodeTabKey(view.title),
    label: view.title,
    bodyHtml: renderVSCodePane(workspaceId, view.title),
    reference: { type: "vscode", title: view.title },
    kind: "resource",
    availability: { phase: "live" },
  }));
}

interface VSCodeWorkViewReference extends WorkspaceWorkViewReference { type: "vscode"; title: string }

function parseVSCodeReference(value: unknown): VSCodeWorkViewReference {
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
      ui: { placement: "work-launcher", label: "New VS Code" },
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
    async execute({ workspaceId }) {
      const existing = listWorkspaceVSCodeTabs(workspaceId)[0];
      return { createdWorkView: { type: "vscode", title: existing?.title ?? createWorkspaceVSCodeTab(workspaceId).title } };
    },
  }],
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: renderWorkspaceVSCodeWorkViews(workspaceId, listWorkspaceVSCodeTabs(workspaceId)),
      commands: vscodeWorkspaceCommands,
    };
  },
};

export { createWorkspaceVSCodeTab };
