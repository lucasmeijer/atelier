import { posix } from "node:path";
import { invalidArguments } from "@atelier/core";
import { openFileInFiles } from "@atelier/files/server";
import type { WorkspaceFileTarget, WorkspaceModuleRouteContext } from "@atelier/shared";
import { listWorkspaceVSCodeViews, openFileInVSCode } from "@atelier/vscode/server";
import { workspaceRoot } from "@atelier/workspace";

export async function openWorkspaceFile(workspaceId: string, target: WorkspaceFileTarget, openWorkView: WorkspaceModuleRouteContext["openWorkView"]): Promise<Response> {
  const path = posix.resolve(workspaceRoot, target.path);
  if (path === workspaceRoot) throw invalidArguments("Choose a file to open");
  const resolvedTarget = { ...target, path };
  const vscode = listWorkspaceVSCodeViews(workspaceId)[0];
  return vscode
    ? openFileInVSCode(workspaceId, vscode.title, resolvedTarget, openWorkView)
    : openFileInFiles(workspaceId, resolvedTarget, openWorkView);
}
