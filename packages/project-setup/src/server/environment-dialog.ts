import { buttonHtml } from "@atelier/design-system/button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { warningBannerHtml } from "@atelier/design-system/warning-banner";
import { domId, escapeHtml, turboStream, turboStreamResponse, type WorkspaceModuleRouteHandler } from "@atelier/shared";
import { AtelierCoreError, invalidArguments, readJsonObject, requestAcceptsJson } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { EnvironmentRequests, PendingEnvironmentRequest } from "../environment-requests.ts";

const decisionSchema = Type.Object({
  name: Type.String(), value: Type.String(), decision: Type.Union([Type.Literal("save"), Type.Literal("skip")]),
}, { additionalProperties: false });
export const environmentRequestHostId = (workspaceId: string) => domId("project_environment_request", workspaceId);
export const environmentRequestPath = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/project-setup/environment-request`;
const dialogId = (id: string) => domId("environment_request_dialog", id);

export function environmentRequestDialog(request: PendingEnvironmentRequest, settings = request.suggestion, error?: string): string {
  const formId = domId("environment_request_form", request.id);
  const save = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Save environment variable" }, attributesHtml: `form="${formId}" name="decision" value="save" data-turbo-submits-with="Saving…"` });
  const skip = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Don’t add this variable" }, attributesHtml: `form="${formId}" name="decision" value="skip" data-setup-request-skip formnovalidate` });
  return dialogHtml({
    element: { id: dialogId(request.id), attributesHtml: 'data-controller="setup-request-dialog" data-action="cancel->setup-request-dialog#preventDismiss"' },
    iconHtml: Icons.Settings,
    titleCaption: "Add environment variable",
    omitCancelButton: true,
    bodyHtml: `${error ? warningBannerHtml({ title: error }) : ""}<p>Save this non-secret value for new workspaces from your project. It won’t change this setup workspace.</p>
      <form id="${formId}" class="project-secret secret-request-fields" method="post" action="${environmentRequestPath(request.workspaceId)}/${request.id}" data-turbo="true">
        <label><span>Name</span><input class="text-field" name="name" value="${escapeHtml(settings.name)}" required autocomplete="off" autofocus></label>
        <label><span>Value</span><input class="text-field" name="value" value="${escapeHtml(settings.value)}" autocomplete="off"></label>
      </form>`,
    footerHtml: `${save}${skip}`,
  });
}

export function environmentRequestOverlay(workspaceId: string, requests: EnvironmentRequests): string {
  const request = requests.forWorkspace(workspaceId);
  return `<turbo-frame id="${environmentRequestHostId(workspaceId)}" data-controller="setup-request-inbox" data-workspace-id="${escapeHtml(workspaceId)}" src="${environmentRequestPath(workspaceId)}">${request ? environmentRequestDialog(request) : ""}</turbo-frame>`;
}

export function environmentRequestRoutes(requests: EnvironmentRequests): WorkspaceModuleRouteHandler {
  return {
    async handle(request, url) {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/project-setup\/environment-request(?:\/([^/]+))?$/);
      if (!match) return undefined;
      const workspaceId = decodeURIComponent(match[1]!);
      const id = match[2];
      const json = requestAcceptsJson(request);
      if (request.method === "GET" && !id) {
        const pending = requests.forWorkspace(workspaceId);
        if (json) return Response.json({ request: pending ? { id: pending.id, suggestion: pending.suggestion } : null }, { headers: { "cache-control": "no-store" } });
        if (request.headers.has("turbo-frame")) return new Response(`<turbo-frame id="${environmentRequestHostId(workspaceId)}">${pending ? environmentRequestDialog(pending) : ""}</turbo-frame>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}` } });
      }
      if (request.method !== "POST" || !id) return undefined;
      const pending = requests.byId(id);
      if (pending.workspaceId !== workspaceId) throw invalidArguments("Environment request does not belong to this workspace.");
      const body = json ? await readJsonObject(request) : Object.fromEntries(await request.formData());
      if (!Value.Check(decisionSchema, body)) throw invalidArguments("Provide a name, value, and save or skip decision.");
      const { decision, ...settings } = body;
      try {
        const result = await requests.complete(id, settings, decision);
        if (json) return Response.json(result, { headers: { "cache-control": "no-store" } });
        return turboStreamResponse(turboStream("remove", dialogId(id)));
      } catch (error) {
        if (json || !(error instanceof AtelierCoreError)) throw error;
        return turboStreamResponse(turboStream("replace", dialogId(id), environmentRequestDialog(pending, settings, error.message)), { status: 422 });
      }
    },
  };
}
