import type { JsonValue } from "@atelier/core";
import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceWorkViewPresentation, WorkspaceWorkViewReference } from "@atelier/shared";
import { renderVSCodePane, vscodeViewKey } from "./render.ts";
import { createWorkspaceVSCodeView, deleteWorkspaceVSCodeState, deleteWorkspaceVSCodeView, listWorkspaceVSCodeViews, type WorkspaceVSCodeView } from "./workspace-vscode.ts";
import { vscodeStaticFiles } from "./static.ts";
import { deleteWorkspaceVSCodeProxyState, patchVSCodeWorkspaceAppResponse, resolveVSCodeWorkspaceAppTarget, vscodeAppKey } from "./proxy.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export function renderWorkspaceVSCodeWorkViews(workspaceId: string, views: WorkspaceVSCodeView[]): WorkspaceWorkViewPresentation[] {
  return views.map((view) => ({
    sourceKey: vscodeViewKey(view.title),
    label: view.title,
    bodyHtml: renderVSCodePane(workspaceId, view.title),
    reference: { type: "vscode", title: view.title },
    kind: "resource",
    availability: { phase: "live" },
  }));
}

const vscodeWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("vscode"),
  title: Type.String({ pattern: "\\S" }),
});

type VSCodeWorkViewReference = Static<typeof vscodeWorkViewReferenceSchema> & WorkspaceWorkViewReference;

function parseVSCodeReference(value: JsonValue): VSCodeWorkViewReference {
  if (!Value.Check(vscodeWorkViewReferenceSchema, value)) throw new Error("title is required");
  return { type: "vscode", title: value.title };
}

export const vscodeWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "vscode.open",
    label: "Open VS Code",
    scope: "workspace",
    surfaces: {
      ui: { placement: "work-launcher", label: "VS Code" },
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
    close: ({ workspaceId, reference }: { workspaceId: string; reference: { type: "vscode"; title: string } }) => deleteWorkspaceVSCodeView(workspaceId, reference.title),
  }],
  staticFiles: vscodeStaticFiles,
  initialize(context) {
    context.registerWorkspaceAppResolver(async (app, requestUrl) => app.appKey === vscodeAppKey
      ? {
          kind: "http",
          target: await resolveVSCodeWorkspaceAppTarget(app, requestUrl),
          adaptResponse: (response, request) => patchVSCodeWorkspaceAppResponse(app, response, request),
        }
      : undefined);
    context.onWorkspaceRemoved((workspaceId) => {
      deleteWorkspaceVSCodeState(workspaceId);
      deleteWorkspaceVSCodeProxyState(workspaceId);
    });
  },
  commands: [{
    id: "vscode.open",
    async execute({ workspaceId }) {
      const existing = listWorkspaceVSCodeViews(workspaceId)[0];
      return { createdWorkView: { type: "vscode", title: existing?.title ?? createWorkspaceVSCodeView(workspaceId).title } };
    },
  }],
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: renderWorkspaceVSCodeWorkViews(workspaceId, listWorkspaceVSCodeViews(workspaceId)),
      commands: vscodeWorkspaceCommands,
    };
  },
};

export { createWorkspaceVSCodeView };
