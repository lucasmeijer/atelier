import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { renderBrowserFrame, renderBrowserTab } from "./render.ts";
import { createWorkspaceBrowserTab, deleteWorkspaceBrowserState, deleteWorkspaceBrowserTab, listWorkspaceBrowserTabs, setWorkspaceBrowserTarget } from "./state.ts";
import { browserStaticFiles } from "./static.ts";
import { isBrowserWorkspaceApp, patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "./proxy.ts";
import { createOrOpenPreviewBrowserTool } from "./agent-tool.ts";
import { registerWorkspaceAgentTool } from "@atelier/agent/server";

const browserCreateCommandId = "browser.create";

function renderWorkspaceBrowserTabs(workspaceId: string): WorkspaceTabContribution[] {
  return listWorkspaceBrowserTabs(workspaceId).map((tab) => renderBrowserTab(workspaceId, tab));
}

const browserWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: browserCreateCommandId,
    label: "New Browser",
    scope: "workspace",
    surfaces: { ui: { placement: "group-menu" } },
  },
];

export const browserWorkspaceModule: WorkspaceModule = {
  id: "browser",
  staticFiles: browserStaticFiles,
  commands: [{
    id: browserCreateCommandId,
    execute({ workspaceId }) {
      return { createdTabKey: createWorkspaceBrowserTab(workspaceId).key, tabPlacement: "preview-group" };
    },
  }],
  routes: [{
    async handle(request, url) {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/browser(?:\/([^/]+))?\/navigate$/);
      if (!match || request.method !== "POST") return undefined;
      return await browserNavigateEndpoint(decodeURIComponent(match[1]!), match[2] ? decodeURIComponent(match[2]) : "browser", request);
    },
  }],
  initialize(context) {
    context.registerWorkspaceAppHandler({
      matches: (app) => isBrowserWorkspaceApp(app.workspaceId, app.appKey),
      resolveTarget: (app, requestUrl) => resolveBrowserWorkspaceAppTarget(app, requestUrl),
      transformResponse: (app, response, request) => patchBrowserWorkspaceAppResponse(app, response, request),
    });
    context.onWorkspaceRemoved((workspaceId) => deleteWorkspaceBrowserState(workspaceId));
    registerWorkspaceAgentTool("create_or_open_preview_browser", (workspaceId, options) => createOrOpenPreviewBrowserTool(workspaceId, {
      events: options.events,
      getTabKeys: () => context.getTabKeys(workspaceId),
      layouts: context.layouts as Parameters<typeof createOrOpenPreviewBrowserTool>[1]["layouts"],
    }));
  },
  tabs: [{
    owns: (tabKey) => /^browser-\d+$/.test(tabKey),
    close: ({ workspaceId, tabKey }) => deleteWorkspaceBrowserTab(workspaceId, tabKey),
  }],
  attachToWorkspace({ workspaceId }) {
    return {
      tabs: renderWorkspaceBrowserTabs(workspaceId),
      commands: browserWorkspaceCommands,
    };
  },
};

async function browserNavigateEndpoint(workspaceId: string, appKey: string, request: Request): Promise<Response> {
  const formData = await request.formData();
  const tab = setWorkspaceBrowserTarget(workspaceId, appKey, String(formData.get("url") ?? ""));
  if (!tab) return new Response("browser tab not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(renderBrowserFrame(workspaceId, appKey), { headers: { "content-type": "text/html; charset=utf-8" } });
}
