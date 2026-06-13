import { getWorkspaceVSCodePort } from "@atelier/core";
import type { WorkspaceAppHost } from "@atelier/workspace-proxy/server";
import { ensureWorkspaceVSCodeServer } from "./workspace-vscode.ts";

export const vscodeAppKey = "vscode";
export const vscodeContainerPort = 8000;

function publishedPortHost(): string {
  return process.env.ATELIER_DOCKER_PUBLISHED_PORT_HOST || "127.0.0.1";
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function unescapeHtmlAttribute(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

export async function patchVSCodeWorkspaceAppResponse(app: WorkspaceAppHost, response: Response): Promise<Response> {
  if (app.appKey !== vscodeAppKey || !response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;
  const text = await response.text();
  const patched = text.replace(/(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]+)(">)/, (_match, prefix, rawSettings, suffix) => {
    const settings = JSON.parse(unescapeHtmlAttribute(rawSettings)) as Record<string, unknown>;
    settings.enableWorkspaceTrust = false;
    settings.configurationDefaults = {
      ...(settings.configurationDefaults as Record<string, unknown> | undefined),
      "security.workspace.trust.enabled": false,
      "security.workspace.trust.startupPrompt": "never",
      "security.workspace.trust.banner": "never",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.startupEditor": "none",
      "chat.disableAIFeatures": true,
    };
    return `${prefix}${escapeHtmlAttribute(JSON.stringify(settings))}${suffix}`;
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
}

export async function resolveVSCodeWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (app.appKey !== vscodeAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureWorkspaceVSCodeServer(app.workspaceId);
  const hostPort = await getWorkspaceVSCodePort(app.workspaceId);
  return new URL(requestUrl.pathname + requestUrl.search, `http://${publishedPortHost()}:${hostPort}`);
}
