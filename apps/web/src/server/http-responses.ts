import { AtelierCoreError } from "@atelier/core";
import { turboStream } from "@atelier/shared";

type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };

export function response(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(body, { ...init, headers });
}

export function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

export function turboReplaceStream(target: string, html: string): string {
  return turboStream("replace", target, html);
}

export function turboUpdateStream(target: string, html: string, options: { method?: "morph" } = {}): string {
  return turboStream("update", target, html, options);
}

export function jsonResponse<Body extends object>(body: Body, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function problemJsonResponse(error: Error): Response {
  const status = error instanceof AtelierCoreError && ["invalid_arguments", "invalid_git_url"].includes(error.code) ? 400
    : error instanceof AtelierCoreError && ["project_not_found", "project_environment_variable_not_found", "project_secret_not_found", "workspace_not_found", "command_not_found", "agent_conversation_not_found", "view_not_found", "terminal_not_found"].includes(error.code) ? 404
      : error instanceof AtelierCoreError && ["last_agent_conversation", "workspace_not_ready"].includes(error.code) ? 409
        : 500;
  const code = error instanceof AtelierCoreError ? error.code : "internal_error";
  const details = error instanceof AtelierCoreError ? error.details : undefined;
  return jsonResponse({ error: { code, message: error.message, ...(details ?? {}) } }, { status });
}
