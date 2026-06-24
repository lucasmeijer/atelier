import type { AtelierEventBus } from "@atelier/core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorkspaceBrowserTab, listWorkspaceBrowserTabs, setWorkspaceBrowserTarget } from "./state.ts";

export interface PreviewBrowserLayoutController {
  ensureTabInAgentFreeGroup(workspaceId: string, tabKeys: string[], tabKey: string): { groupId: string; moved: boolean; createdGroup: boolean } | undefined;
}

export interface CreateOrOpenPreviewBrowserToolDeps {
  getTabKeys(): Promise<string[]>;
  layouts: PreviewBrowserLayoutController;
  events?: AtelierEventBus;
}

export function createOrOpenPreviewBrowserTool(workspaceId: string, deps: CreateOrOpenPreviewBrowserToolDeps): ToolDefinition<any, any> {
  return defineTool({
    name: "create_or_open_preview_browser",
    label: "Open Preview Browser",
    description: "Instruct Atelier to show the user a preview browser that loads the specified url. Write the url from the network perspective of the container itself. So you can use http://localhost:3000/.",
    parameters: Type.Object({
      url: Type.String({
        description: "URL to load in the preview browser, written from the network perspective of the container itself. For example: http://localhost:3000/",
      }),
    }),
    execute: async (_toolCallId: string, params: { url: string }) => {
      const browserTab = listWorkspaceBrowserTabs(workspaceId)[0] ?? createWorkspaceBrowserTab(workspaceId);
      const tab = setWorkspaceBrowserTarget(workspaceId, browserTab.key, params.url) ?? browserTab;
      const placement = deps.layouts.ensureTabInAgentFreeGroup(workspaceId, await deps.getTabKeys(), browserTab.key);
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
  });
}
