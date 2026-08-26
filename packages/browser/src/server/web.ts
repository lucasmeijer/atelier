import { turboStream, type WorkspaceCommandContribution, type WorkspaceModule, type WorkspaceModuleCommandHandler, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { renderBrowserFrame, renderBrowserWorkView } from "./render.ts";
import { browserFrameId, createWorkspaceBrowserView, deleteWorkspaceBrowserState, deleteWorkspaceBrowserView, listWorkspaceBrowserViews, setWorkspaceBrowserTarget } from "./state.ts";
import { browserStaticFiles } from "./static.ts";
import { isBrowserWorkspaceApp, patchBrowserWorkspaceAppRequestHeaders, patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "./proxy.ts";
import { invalidArguments, readJsonObject, requestAcceptsJson, type JsonObject, type JsonValue } from "@atelier/core";
import { createBrowserPresenter } from "./agent-tool.ts";
import { registerWorkspacePresenter } from "@atelier/agent/server";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const browserCreateCommandId = "browser.create";
const browserCreateInputSchema = Type.Object({ url: Type.Optional(Type.String()) });
const browserNavigateInputSchema = Type.Object({ url: Type.String() });

const browserCreateCommand: WorkspaceModuleCommandHandler<Static<typeof browserCreateInputSchema>> = {
  id: browserCreateCommandId,
  inputSchema: browserCreateInputSchema,
  execute({ workspaceId, input }) {
    const browser = createWorkspaceBrowserView(workspaceId);
    if (input.url) setWorkspaceBrowserTarget(workspaceId, browser.key, input.url);
    return { createdWorkView: { type: "browser", browserId: browser.key } };
  },
};

const browserWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("browser"),
  browserId: Type.String({ pattern: "^browser-\\d+$" }),
});

type BrowserWorkViewReference = Static<typeof browserWorkViewReferenceSchema>;

function parseBrowserReference(value: JsonValue): BrowserWorkViewReference {
  if (!Value.Check(browserWorkViewReferenceSchema, value)) throw new Error("browserId is invalid");
  return { type: "browser", browserId: value.browserId };
}

function renderWorkspaceBrowserWorkViews(workspaceId: string): WorkspaceWorkViewPresentation[] {
  return listWorkspaceBrowserViews(workspaceId).map((view) => renderBrowserWorkView(workspaceId, view));
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
    close: ({ workspaceId, reference }: { workspaceId: string; reference: { type: "browser"; browserId: string } }) => deleteWorkspaceBrowserView(workspaceId, reference.browserId),
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
    registerWorkspacePresenter("browser", (workspaceId) => createBrowserPresenter(workspaceId, {
      async presentBrowser(view) {
        await context.presentWorkView(workspaceId, { type: "browser", browserId: view.key });
        context.broadcastWorkspace(workspaceId, turboStream("replace", browserFrameId(workspaceId, view.key), renderBrowserFrame(workspaceId, view)));
      },
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
  const url = wantsJson
    ? browserNavigateJsonUrl(await readJsonObject(request))
    : String((await request.formData()).get("url") ?? "");

  const view = setWorkspaceBrowserTarget(workspaceId, appKey, url);
  if (!view) return wantsJson
    ? Response.json({ error: { code: "view_not_found", message: `browser view not found: ${appKey}` } }, { status: 404 })
    : new Response("browser view not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return wantsJson
    ? Response.json({ view: { key: view.key, label: view.label, url: view.targetUrl } })
    : new Response(renderBrowserFrame(workspaceId, view), { headers: { "content-type": "text/html; charset=utf-8" } });
}

function browserNavigateJsonUrl(input: JsonObject): string {
  if (!Value.Check(browserNavigateInputSchema, input)) throw invalidArguments("url is required");
  return input.url;
}
