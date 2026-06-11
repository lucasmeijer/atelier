import type { WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { renderBrowserFrame, renderBrowserTab } from "./render.ts";
import { createWorkspaceBrowserTab, deleteWorkspaceBrowserTab, listWorkspaceBrowserTabs, setWorkspaceBrowserTarget } from "./state.ts";

export function renderWorkspaceBrowserTabs(workspaceId: string): WorkspaceTabContribution[] {
  return listWorkspaceBrowserTabs(workspaceId).map((tab) => renderBrowserTab(workspaceId, tab));
}

export const browserWorkspaceModule: WorkspaceModule = {
  id: "browser",
  attachToWorkspace({ workspaceId }) {
    return {
      tabs: renderWorkspaceBrowserTabs(workspaceId),
      tabActions: [{ key: "browser:create", label: "New Browser" }],
    };
  },
};

export function createWorkspaceBrowserTabForWorkspace(workspaceId: string): { key: string; label: string } {
  const tab = createWorkspaceBrowserTab(workspaceId);
  return { key: tab.appKey, label: tab.label };
}

export function deleteWorkspaceBrowserTabForWorkspace(workspaceId: string, appKey: string): void {
  deleteWorkspaceBrowserTab(workspaceId, appKey);
}

export async function browserNavigateEndpoint(workspaceId: string, appKey: string, request: Request): Promise<Response> {
  const formData = await request.formData();
  setWorkspaceBrowserTarget(workspaceId, appKey, String(formData.get("url") ?? ""));
  return new Response(renderBrowserFrame(workspaceId, appKey), { headers: { "content-type": "text/html; charset=utf-8" } });
}
