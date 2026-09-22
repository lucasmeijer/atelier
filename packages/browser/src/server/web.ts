import { registerWorkspacePresenter } from "@atelier/agent/server";
import { invalidArguments, readJsonObject, requestAcceptsJson, type JsonObject, type JsonValue } from "@atelier/core";
import { Icons } from "@atelier/design-system/icons";
import { turboStreamResponse, type WorkspaceCommandContribution, type WorkspaceModule, type WorkspaceModuleCommandHandler } from "@atelier/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isWorkspaceLoopbackHost } from "../shared.ts";
import { createBrowserPresenter } from "./agent-tool.ts";
import { browserWorkViewPresentation, renderBrowserWorkViewBody } from "./render.ts";
import type { WorkspaceBrowserView } from "./state.ts";
import { createWorkspaceBrowserView, deleteWorkspaceBrowserState, deleteWorkspaceBrowserView, getWorkspaceBrowserView, listWorkspaceBrowserViews, setWorkspaceBrowserTarget } from "./state.ts";
import { browserStaticFiles } from "./static.ts";

let publishWorkspacePort: (workspaceId: string, port: number, protocol?: "http" | "https") => Promise<string>;
async function previewUrl(workspaceId: string, view: WorkspaceBrowserView): Promise<string> {
  if (!view.targetUrl) return "";
  const target = new URL(view.targetUrl);
  if (!isWorkspaceLoopbackHost(target.hostname)) return target.toString();
  const origin = await publishWorkspacePort(workspaceId, Number(target.port || (target.protocol === "https:" ? 443 : 80)), target.protocol === "https:" ? "https" : "http");
  return `${origin}${target.pathname}${target.search}${target.hash}`;
}

const browserCreateCommandId = "browser.create";
const browserOpenCommandId = "browser.open";
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

const browserOpenCommand: WorkspaceModuleCommandHandler = {
  id: browserOpenCommandId,
  execute({ workspaceId }) {
    const browser = listWorkspaceBrowserViews(workspaceId)[0] ?? createWorkspaceBrowserView(workspaceId);
    return { createdWorkView: { type: "browser", browserId: browser.key } };
  },
};

const browserWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("browser"),
  browserId: Type.String({ pattern: "^browser-[a-zA-Z0-9-]+$" }),
});

type BrowserWorkViewReference = Static<typeof browserWorkViewReferenceSchema>;

function parseBrowserReference(value: JsonValue): BrowserWorkViewReference {
  if (!Value.Check(browserWorkViewReferenceSchema, value)) throw new Error("browserId is invalid");
  return { type: "browser", browserId: value.browserId };
}

const browserWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: browserOpenCommandId,
    label: "Open Browser",
    description: "Open the first existing Browser view, or create one if none exists.",
    scope: "workspace",
    surfaces: { shortcut: { defaultBinding: "Meta+Alt+KeyB" } },
  },
  {
    id: browserCreateCommandId,
    label: "New Browser",
    scope: "workspace",
    surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Browser, label: "Browser" } },
  },
];

export const browserWorkspaceModule: WorkspaceModule = {
  id: "browser",
  workViews: [{
    type: "browser",
    parseReference: parseBrowserReference,
    identity: (reference: { type: "browser"; browserId: string }) => reference.browserId,
    render: async ({ workspaceId, reference }: { workspaceId: string; reference: BrowserWorkViewReference }) => {
      const view = getWorkspaceBrowserView(workspaceId, reference.browserId);
      if (!view) throw new Error(`Browser Work view not found: ${reference.browserId}`);
      return renderBrowserWorkViewBody(workspaceId, view, await previewUrl(workspaceId, view));
    },
    close: ({ workspaceId, reference }: { workspaceId: string; reference: { type: "browser"; browserId: string } }) => deleteWorkspaceBrowserView(workspaceId, reference.browserId),
  }],
  staticFiles: browserStaticFiles,
  commands: [browserCreateCommand, browserOpenCommand],
  routes: [{
    async handle(request, url) {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/browser\/([^/]+)\/navigate$/);
      if (!match || request.method !== "POST") return undefined;
      return await browserNavigateEndpoint(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!), request);
    },
  }],
  initialize(context) {
    publishWorkspacePort = context.publishWorkspacePort;
    context.onWorkspaceRemoved((workspaceId) => deleteWorkspaceBrowserState(workspaceId));
    registerWorkspacePresenter("browser", (workspaceId) => createBrowserPresenter(workspaceId, {
      async presentBrowser(view) {
        await context.presentWorkView(workspaceId, { type: "browser", browserId: view.key });
        context.invalidateWorkspace(workspaceId);
      },
    }));
  },
  attachToWorkspace({ workspaceId }) {
    return {
      workViews: listWorkspaceBrowserViews(workspaceId).map(browserWorkViewPresentation),
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
    : turboStreamResponse("");
}

function browserNavigateJsonUrl(input: JsonObject): string {
  if (!Value.Check(browserNavigateInputSchema, input)) throw invalidArguments("url is required");
  return input.url;
}
