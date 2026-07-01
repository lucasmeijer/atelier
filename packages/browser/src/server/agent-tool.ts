import type { WorkspacePresenterDefinition, WorkspacePresenterDeps } from "@atelier/agent/server";
import { Type } from "typebox";
import { createWorkspaceBrowserTab, listWorkspaceBrowserTabs, setWorkspaceBrowserTarget } from "./state.ts";

export function createBrowserPresenter(workspaceId: string, deps: WorkspacePresenterDeps): WorkspacePresenterDefinition<{ kind: "browser"; url: string }> {
  return {
    kind: "browser",
    description: "Present a URL in Atelier's inline preview browser.",
    parameters: {
      url: Type.String({
        description: "URL to load in the preview browser, written from the network perspective of the workspace container. For local dev servers, use localhost with one of Atelier's exposed preview ports, for example: http://localhost:3000/",
      }),
    },
    execute: async (_toolCallId: string, params: { kind: "browser"; url: string }) => {
      const browserTab = listWorkspaceBrowserTabs(workspaceId)[0] ?? createWorkspaceBrowserTab(workspaceId);
      const tab = setWorkspaceBrowserTarget(workspaceId, browserTab.key, params.url) ?? browserTab;
      const placement = deps.layouts.ensureTabInPreviewGroup(workspaceId, await deps.getTabKeys(), browserTab.key);
      await deps.events?.emit("workspace_tabs_changed", { workspaceId });
      const details = {
        tab: browserTab.key,
        url: tab.targetUrl,
        groupId: placement?.groupId,
        moved: placement?.moved ?? false,
        createdGroup: placement?.createdGroup ?? false,
      };
      return {
        content: [{ type: "text" as const, text: `Preview browser opened at ${tab.targetUrl}` }],
        details,
      };
    },
  };
}
