import type { WorkspacePresenterDefinition } from "@atelier/agent/server";
import { Type } from "typebox";
import { createWorkspaceBrowserView, listWorkspaceBrowserViews, setWorkspaceBrowserTarget, type WorkspaceBrowserView } from "./state.ts";

interface BrowserPresenterDeps {
  presentBrowser(view: WorkspaceBrowserView): Promise<void>;
}

export function createBrowserPresenter(workspaceId: string, deps: BrowserPresenterDeps): WorkspacePresenterDefinition<{ kind: "browser"; url: string }> {
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
      const view = setWorkspaceBrowserTarget(workspaceId, browserView.key, params.url);
      if (!view) throw new Error(`Browser view disappeared while presenting: ${browserView.key}`);
      await deps.presentBrowser(view);
      const details = { workView: { type: "browser", browserId: browserView.key }, url: view.targetUrl };
      return {
        content: [{ type: "text" as const, text: `Preview browser opened at ${view.targetUrl}` }],
        details,
      };
    },
  };
}
