import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceModuleCommandHandler, WorkspaceWorkViewPresentation, WorkspaceWorkViewReference } from "@atelier/shared";
import { renderBrowserFrame, renderBrowserWorkView } from "./render.ts";
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
    return { createdWorkView: { type: "browser", browserId: browser.key } };
  },
};

interface BrowserWorkViewReference extends WorkspaceWorkViewReference { type: "browser"; browserId: string }

function parseBrowserReference(value: unknown): BrowserWorkViewReference {
  const reference = value as { type?: unknown; browserId?: unknown };
  if (reference?.type !== "browser" || typeof reference.browserId !== "string" || !/^browser-\d+$/.test(reference.browserId)) throw new Error("browserId is invalid");
  return { type: "browser", browserId: reference.browserId };
}

function renderWorkspaceBrowserWorkViews(workspaceId: string): WorkspaceWorkViewPresentation[] {
  return listWorkspaceBrowserTabs(workspaceId).map((view) => renderBrowserWorkView(workspaceId, view));
}

const browserWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: browserCreateCommandId,
    label: "New Browser",
    scope: "workspace",
    surfaces: { ui: { placement: "work-launcher" } },
  },
];

export const browserWorkspaceModule: WorkspaceModule = {
  id: "browser",
  workViews: [{
    type: "browser",
    parseReference: parseBrowserReference,
    identity: (reference: { type: "browser"; browserId: string }) => reference.browserId,
    close: ({ workspaceId, reference }: { workspaceId: string; reference: { type: "browser"; browserId: string } }) => deleteWorkspaceBrowserTab(workspaceId, reference.browserId),
  }],
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
      presentWorkView: (reference) => context.presentWorkView(workspaceId, reference),
    }));
  },
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: renderWorkspaceBrowserWorkViews(workspaceId),
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
