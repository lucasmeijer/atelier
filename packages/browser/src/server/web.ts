import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { renderBrowserFrame, renderBrowserTab } from "./render.ts";
import { createWorkspaceBrowserTab, deleteWorkspaceBrowserState, deleteWorkspaceBrowserTab, listWorkspaceBrowserTabs, setWorkspaceBrowserTarget } from "./state.ts";
import { browserStaticFiles } from "./static.ts";
import { isBrowserWorkspaceApp, patchBrowserWorkspaceAppRequestHeaders, patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "./proxy.ts";
import { invalidArguments, readJsonObject, requestAcceptsJson, type JsonObject } from "@atelier/core";
import { createBrowserPresenter } from "./agent-tool.ts";
import { registerWorkspacePresenter, type WorkspacePresenterDeps } from "@atelier/agent/server";
import { Type } from "typebox";

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
    inputSchema: Type.Object({ url: Type.Optional(Type.String()) }),
    execute({ workspaceId, input }) {
      const browser = createWorkspaceBrowserTab(workspaceId);
      const url = (input as { url?: string }).url;
      if (url) setWorkspaceBrowserTarget(workspaceId, browser.key, url);
      return { createdTabKey: browser.key, tabPlacement: "preview-group" };
    },
  }],
  routes: [{
    async handle(request, url) {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/browser\/([^/]+)\/navigate$/);
      if (!match || request.method !== "POST") return undefined;
      return await browserNavigateEndpoint(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), request);
    },
  }],
  initialize(context) {
    context.registerWorkspaceAppHandler({
      matches: (app) => isBrowserWorkspaceApp(app.workspaceId, app.appKey),
      resolveTarget: (app, requestUrl) => resolveBrowserWorkspaceAppTarget(app, requestUrl),
      transformRequestHeaders: (app, headers, target, request) => patchBrowserWorkspaceAppRequestHeaders(app, headers, target, request),
      transformResponse: (app, response, request) => patchBrowserWorkspaceAppResponse(app, response, request),
    });
    context.onWorkspaceRemoved((workspaceId) => deleteWorkspaceBrowserState(workspaceId));
    registerWorkspacePresenter("browser", (workspaceId, options) => createBrowserPresenter(workspaceId, {
      events: options.events,
      getTabKeys: () => context.getTabKeys(workspaceId),
      layouts: context.layouts as WorkspacePresenterDeps["layouts"],
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

function parseBrowserNavigationUrl(value: JsonObject): string {
  const url = value.url;
  if (typeof url !== "string") throw invalidArguments("url is required");
  return url;
}

async function browserNavigateEndpoint(workspaceId: string, appKey: string, request: Request): Promise<Response> {
  const wantsJson = requestAcceptsJson(request);
  const url = wantsJson
    ? await readJsonObject(request, parseBrowserNavigationUrl)
    : String((await request.formData()).get("url") ?? "");

  const tab = setWorkspaceBrowserTarget(workspaceId, appKey, url);
  if (!tab) return wantsJson
    ? Response.json({ error: { code: "tab_not_found", message: `browser tab not found: ${appKey}` } }, { status: 404 })
    : new Response("browser tab not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return wantsJson
    ? Response.json({ tab: { key: tab.key, label: tab.label, url: tab.targetUrl } })
    : new Response(renderBrowserFrame(workspaceId, tab), { headers: { "content-type": "text/html; charset=utf-8" } });
}
