import { getWorkspaceVSCodePort, workspaceContainerName, workspaceVSCodePort } from "@atelier/workspace";
import type { WorkspaceAppHost } from "@atelier/workspace-proxy/server";
import { ensureWorkspaceVSCodeServer } from "./workspace-vscode.ts";

export const vscodeAppKey = "vscode";
export const vscodeContainerPort = 8000;

function publishedPortHost(): string {
  return process.env.ATELIER_DOCKER_PUBLISHED_PORT_HOST || "127.0.0.1";
}

function useWorkspaceDockerNetwork(): boolean {
  return Boolean(process.env.ATELIER_WORKSPACE_DOCKER_NETWORK);
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function unescapeHtmlAttribute(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

const serverEnsures = new Map<string, Promise<void>>();
const publishedPorts = new Map<string, Promise<number>>();

type VSCodeThemeDefaults = {
  colorTheme: string;
  colorCustomizations: Record<string, string>;
};

function requestColor(url: URL, name: string): string | undefined {
  const color = url.searchParams.get(name)?.trim();
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
}

function luminance(hex: string): number {
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function themeDefaultsForRequest(request: Request): VSCodeThemeDefaults | undefined {
  const url = new URL(request.url);
  const bg = requestColor(url, "atelierBg");
  const panel = requestColor(url, "atelierPanel");
  const elev = requestColor(url, "atelierElev");
  const text = requestColor(url, "atelierText");
  const line = requestColor(url, "atelierLine");
  const accent = requestColor(url, "atelierAccent");
  if (!bg || !panel || !elev || !text) return undefined;
  return {
    colorTheme: luminance(bg) > 0.55 ? "Default Light Modern" : "Default Dark Modern",
    colorCustomizations: {
      "activityBar.background": panel,
      "activityBar.foreground": text,
      "editor.background": bg,
      "editor.foreground": text,
      "editorGroupHeader.tabsBackground": panel,
      "sideBar.background": panel,
      "sideBar.foreground": text,
      "statusBar.background": elev,
      "statusBar.foreground": text,
      "titleBar.activeBackground": panel,
      "titleBar.activeForeground": text,
      ...(line ? { "panel.border": line, "sideBar.border": line } : {}),
      ...(accent ? { "focusBorder": accent, "button.background": accent } : {}),
    },
  };
}

async function ensureVSCodeServerOnce(workspaceId: string): Promise<void> {
  let promise = serverEnsures.get(workspaceId);
  if (!promise) {
    promise = ensureWorkspaceVSCodeServer(workspaceId).finally(() => {
      serverEnsures.delete(workspaceId);
    });
    serverEnsures.set(workspaceId, promise);
  }
  await promise;
}

async function getVSCodePublishedPort(workspaceId: string): Promise<number> {
  let promise = publishedPorts.get(workspaceId);
  if (!promise) {
    promise = getWorkspaceVSCodePort(workspaceId).catch((error) => {
      publishedPorts.delete(workspaceId);
      throw error;
    });
    publishedPorts.set(workspaceId, promise);
  }
  return await promise;
}

export async function patchVSCodeWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request): Promise<Response> {
  if (app.appKey !== vscodeAppKey || !response.ok || !response.headers.get("content-type")?.includes("text/html")) return response;
  const themeDefaults = themeDefaultsForRequest(request);
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
      ...(themeDefaults ? { "workbench.colorTheme": themeDefaults.colorTheme, "workbench.colorCustomizations": themeDefaults.colorCustomizations } : {}),
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
  await ensureVSCodeServerOnce(app.workspaceId);
  const targetUrl = new URL(requestUrl.pathname + requestUrl.search, "http://atelier.local");
  [...targetUrl.searchParams.keys()].forEach((key) => {
    if (key.startsWith("atelier")) targetUrl.searchParams.delete(key);
  });
  const path = targetUrl.pathname + targetUrl.search;
  if (useWorkspaceDockerNetwork()) return new URL(path, `http://${workspaceContainerName(app.workspaceId)}:${workspaceVSCodePort}`);
  const hostPort = await getVSCodePublishedPort(app.workspaceId);
  return new URL(path, `http://${publishedPortHost()}:${hostPort}`);
}
