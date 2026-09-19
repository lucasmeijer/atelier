import { AtelierCoreError } from "@atelier/core";
export { response, replace as turboReplaceStream, update as turboUpdateStream, wantsStream as wantsTurboStream } from "@atelier/shared/http";

type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };

export function jsonResponse<Body extends object>(body: Body, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function httpErrorStatus(error: Error): number {
  return error instanceof AtelierCoreError && ["invalid_arguments", "invalid_git_url", "terminal_invalid_cwd"].includes(error.code) ? 400
    : error instanceof AtelierCoreError && ["repo_not_found", "project_not_found", "project_environment_variable_not_found", "project_secret_not_found", "workspace_not_found", "command_not_found", "agent_conversation_not_found", "view_not_found", "terminal_not_found"].includes(error.code) ? 404
      : error instanceof AtelierCoreError && ["agent_setup_required", "last_agent_conversation", "workspace_not_ready", "project_secret_routing_changed", "project_settings_conflict"].includes(error.code) ? 409
        : 500;
}

export function problemJsonResponse(error: Error): Response {
  const status = httpErrorStatus(error);
  const code = error instanceof AtelierCoreError ? error.code : "internal_error";
  const details = error instanceof AtelierCoreError ? error.details : undefined;
  return jsonResponse({ error: { code, message: error.message, ...(details ?? {}) } }, { status });
}
