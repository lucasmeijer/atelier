import type { WorkspacePresenterDefinition, WorkspacePresenterDeps } from "@atelier/agent/server";
import { Type } from "typebox";
import { createWorkspaceBrowserView, listWorkspaceBrowserViews, setWorkspaceBrowserTarget } from "./state.ts";

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
      const browserView = listWorkspaceBrowserViews(workspaceId)[0] ?? createWorkspaceBrowserView(workspaceId);
      const view = setWorkspaceBrowserTarget(workspaceId, browserView.key, params.url) ?? browserView;
      await deps.presentWorkView({ type: "browser", browserId: browserView.key });
      const details = { workView: { type: "browser", browserId: browserView.key }, url: view.targetUrl };
      return {
        content: [{ type: "text" as const, text: `Preview browser opened at ${view.targetUrl}` }],
        details,
      };
    },
  };
}
