import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceModuleCommandHandler, WorkspaceTabContribution } from "@atelier/shared";
import { renderBrowserFrame, renderBrowserTab } from "./render.ts";
import { createWorkspaceBrowserTab, deleteWorkspaceBrowserState, deleteWorkspaceBrowserTab, listWorkspaceBrowserTabs, setWorkspaceBrowserTarget } from "./state.ts";
import { browserStaticFiles } from "./static.ts";
import { isBrowserWorkspaceApp, patchBrowserWorkspaceAppRequestHeaders, patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "./proxy.ts";
import { invalidArguments, readJsonObject, requestAcceptsJson } from "@atelier/core";
import { createBrowserPresenter } from "./agent-tool.ts";
import { registerWorkspacePresenter } from "@atelier/agent/server";
import { Type, type Static } from "typebox";

const browserCreateCommandId = "browser.create";
const browserCreateInputSchema = Type.Object({ url: Type.Optional(Type.String()) });

const browserCreateCommand: WorkspaceModuleCommandHandler<Static<typeof browserCreateInputSchema>> = {
  id: browserCreateCommandId,
  inputSchema: browserCreateInputSchema,
  execute({ workspaceId, input }) {
    const browser = createWorkspaceBrowserTab(workspaceId);
    if (input.url) setWorkspaceBrowserTarget(workspaceId, browser.key, input.url);
    return { createdTabKey: browser.key, tabPlacement: "preview-group" };
  },
};

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
  commands: [browserCreateCommand],
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
      layouts: context.layouts,
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
  const wantsJson = requestAcceptsJson(request);
  const value = wantsJson ? (await readJsonObject(request)).url : (await request.formData()).get("url");
  if (wantsJson && typeof value !== "string") throw invalidArguments("url is required");
  const url = String(value ?? "");

  const tab = setWorkspaceBrowserTarget(workspaceId, appKey, url);
  if (!tab) return wantsJson
    ? Response.json({ error: { code: "tab_not_found", message: `browser tab not found: ${appKey}` } }, { status: 404 })
    : new Response("browser tab not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return wantsJson
    ? Response.json({ tab: { key: tab.key, label: tab.label, url: tab.targetUrl } })
    : new Response(renderBrowserFrame(workspaceId, tab), { headers: { "content-type": "text/html; charset=utf-8" } });
}
