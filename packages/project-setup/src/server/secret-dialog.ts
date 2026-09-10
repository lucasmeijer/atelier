import { buttonHtml } from "@atelier/design-system/button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { toggleHtml } from "@atelier/design-system/toggle";
import { warningBannerHtml } from "@atelier/design-system/warning-banner";
import { domId, escapeHtml, turboStream, turboStreamResponse, type WorkspaceModuleRouteHandler } from "@atelier/shared";
import { AtelierCoreError, invalidArguments, readJsonObject, requestAcceptsJson } from "@atelier/core";
import { secretSuggestionSchema, type PendingSecretRequest, type SecretRequests, type SecretSuggestion } from "../secret-requests.ts";

import { Type } from "typebox";
import { Value } from "typebox/value";

const secretDecisionSchema = Type.Object({
  ...secretSuggestionSchema.properties,
  decision: Type.Union([Type.Literal("save"), Type.Literal("skip")]),
  secretValue: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const secretRequestHostId = (workspaceId: string) => domId("project_secret_request", workspaceId);
export const secretRequestPath = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/project-setup/secret-request`;
const dialogId = (id: string) => domId("secret_request_dialog", id);

export function secretRequestDialog(request: PendingSecretRequest, settings = request.suggestion, error?: string): string {
  const formId = domId("secret_request_form", request.id);
  const field = (label: string, name: string, value: string, attributes = "") => `<label><span>${label}</span><input class="text-field" name="${name}" value="${escapeHtml(value)}" ${attributes}></label>`;
  const save = buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Save secret" }, attributesHtml: `form="${formId}" name="decision" value="save" disabled data-secret-request-target="save" data-turbo-submits-with="Saving…"` });
  const skip = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "I don’t want to set up this secret right now" }, attributesHtml: `form="${formId}" name="decision" value="skip" data-setup-request-skip formnovalidate data-turbo-submits-with="Saving…"` });
  return dialogHtml({
    element: { id: dialogId(request.id), attributesHtml: 'data-controller="setup-request-dialog secret-request" data-action="cancel->setup-request-dialog#preventDismiss input->secret-request#updateSave change->secret-request#toggleChanged"' },
    iconHtml: Icons.Settings,
    titleCaption: `Set up ${settings.envName}`,
    omitCancelButton: true,
    bodyHtml: `${error ? warningBannerHtml({ title: error }) : ""}<p>Your secret value stays private and is never shared with the agent.</p>${request.existing?.configured ? '<p>A value is already stored. Choosing to set this up later keeps that value.</p>' : ""}
      <form id="${formId}" class="project-secret secret-request-fields" method="post" action="${secretRequestPath(request.workspaceId)}/${request.id}" data-turbo="true">
        ${field("Environment variable", "envName", settings.envName, 'required autocomplete="off"')}
        ${field("Host", "hostPattern", settings.hostPattern, 'required autocomplete="off"')}
        ${field("Secret", "secretValue", "", 'type="password" required autocomplete="new-password" autofocus data-secret-request-target="value"')}
        ${field("Placeholder", "placeholder", settings.placeholder ?? "", 'autocomplete="off" placeholder="You rarely need to fill this in"')}
        <label><span>Needed for</span><textarea class="textarea" name="annotation" rows="2">${escapeHtml(settings.annotation)}</textarea></label>
        <div class="project-secret-requirement"><span>Requirement</span><input type="hidden" name="optional" value="${settings.optional}">${toggleHtml({ variant: "button", label: "Secret requirement", name: "optional", value: String(settings.optional), options: [{ value: "false", label: "Mandatory" }, { value: "true", label: "Optional" }] })}</div>
      </form>`,
    footerHtml: `${save}${skip}`,
  });
}

export function secretRequestOverlay(workspaceId: string, requests: SecretRequests): string {
  const request = requests.forWorkspace(workspaceId);
  return `<turbo-frame id="${secretRequestHostId(workspaceId)}" data-controller="setup-request-inbox" data-workspace-id="${escapeHtml(workspaceId)}" src="${secretRequestPath(workspaceId)}">${request ? secretRequestDialog(request) : ""}</turbo-frame>`;
}

export function secretRequestRoutes(requests: SecretRequests): WorkspaceModuleRouteHandler {
  return {
    async handle(request, url) {
      const match = url.pathname.match(/^\/workspaces\/([^/]+)\/project-setup\/secret-request(?:\/([^/]+))?$/);
      if (!match) return undefined;
      const workspaceId = decodeURIComponent(match[1]!);
      const id = match[2];
      const json = requestAcceptsJson(request);
      if (request.method === "GET" && !id) {
        const pending = requests.forWorkspace(workspaceId);
        if (json) return Response.json({ request: pending ? { id: pending.id, suggestion: pending.suggestion, configured: pending.existing?.configured ?? false } : null }, { headers: { "cache-control": "no-store" } });
        if (request.headers.has("turbo-frame")) return new Response(`<turbo-frame id="${secretRequestHostId(workspaceId)}">${pending ? secretRequestDialog(pending) : ""}</turbo-frame>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}` } });
      }
      if (request.method !== "POST" || !id) return undefined;
      const pending = requests.byId(id);
      if (pending.workspaceId !== workspaceId) throw invalidArguments("Secret request does not belong to this workspace.");
      const body = json ? await readJsonObject(request) : Object.fromEntries(await request.formData());
      const optional = body.optional;
      const settings: SecretSuggestion = {
        envName: String(body.envName ?? "").trim(), hostPattern: String(body.hostPattern ?? "").trim(),
        annotation: String(body.annotation ?? ""), placeholder: String(body.placeholder ?? ""),
        optional: optional === true || optional === "true",
      };
      try {
        if (optional !== true && optional !== false && optional !== "true" && optional !== "false") throw invalidArguments("Choose whether this secret is mandatory or optional.");
        if (body.decision !== "save" && body.decision !== "skip") throw invalidArguments("Choose to save the secret or set it up later.");
        const input = json ? body : { ...body, optional: settings.optional };
        if (!Value.Check(secretDecisionSchema, input)) throw invalidArguments("Provide valid secret settings and a save or skip decision.");
        const { decision, secretValue, ...finalSettings } = input;
        const result = await requests.complete(id, finalSettings, decision, secretValue ?? "");
        if (json) return Response.json(result, { headers: { "cache-control": "no-store" } });
        return turboStreamResponse(turboStream("remove", dialogId(id)));
      } catch (error) {
        if (json || !(error instanceof AtelierCoreError)) throw error;
        return turboStreamResponse(turboStream("replace", dialogId(id), secretRequestDialog(pending, settings, error.message)), { status: 422 });
      }
    },
  };
}
