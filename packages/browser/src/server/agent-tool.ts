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
      await deps.events?.emit("workspace_tabs_changed", { workspaceId });
      await deps.presentWorkView({ type: "browser", browserId: browserTab.key });
      const details = { workView: { type: "browser", browserId: browserTab.key }, url: tab.targetUrl };
      return {
        content: [{ type: "text" as const, text: `Preview browser opened at ${tab.targetUrl}` }],
        details,
      };
    },
  };
}
