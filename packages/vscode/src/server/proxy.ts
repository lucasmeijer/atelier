import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceHttpAppBackend } from "@atelier/shared";
import { isJsonObject } from "@atelier/core";
import { workspacePortBackend, workspaceVSCodePort } from "@atelier/workspace";
import { publicWorkspaceAppOrigin, type WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { ensureWorkspaceVSCodeServer } from "./workspace-vscode.ts";

const gallerySchema = Type.Object({ resourceUrlTemplate: Type.Optional(Type.String()) });
const remoteAuthoritySchema = Type.String();

export const vscodeAppKey = "vscode";
export const vscodeContainerPort = 8000;

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function unescapeHtmlAttribute(value: string): string {
  return value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

const serverCheckTtlMs = 30_000;
const serverChecks = new Map<string, { promise: Promise<void>; checkedAt: number }>();

export function deleteWorkspaceVSCodeProxyState(workspaceId: string): void {
  serverChecks.delete(workspaceId);
}

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
  interface VSCodeColorCustomizations {
    [name: string]: string;
  }
  const colorCustomizations: VSCodeColorCustomizations = {
    "activityBar.background": panel,
    "activityBar.foreground": text,
    "editor.background": bg,
    "editor.foreground": text,
    "editorGroup.border": line ?? elev,
    "editorGroupHeader.tabsBackground": panel,
    "editorGroupHeader.tabsBorder": line ?? elev,
    "tab.activeBackground": bg,
    "tab.activeForeground": text,
    "tab.border": line ?? elev,
    "tab.hoverBackground": elev,
    "tab.inactiveBackground": panel,
    "tab.inactiveForeground": text,
    "tab.unfocusedActiveBackground": bg,
    "tab.unfocusedActiveForeground": text,
    "tab.unfocusedInactiveBackground": panel,
    "tab.unfocusedInactiveForeground": text,
    "sideBar.background": panel,
    "sideBar.foreground": text,
    "sideBarSectionHeader.background": elev,
    "sideBarSectionHeader.border": line ?? elev,
    "sideBarSectionHeader.foreground": text,
    "sideBarTitle.foreground": text,
    "list.activeSelectionBackground": elev,
    "list.activeSelectionForeground": text,
    "list.hoverBackground": elev,
    "list.hoverForeground": text,
    "list.inactiveSelectionBackground": elev,
    "list.inactiveSelectionForeground": text,
    "statusBar.background": elev,
    "statusBar.foreground": text,
    "titleBar.activeBackground": panel,
    "titleBar.activeForeground": text,
    "titleBar.inactiveBackground": panel,
    "titleBar.inactiveForeground": text,
  };
  if (line) Object.assign(colorCustomizations, { "panel.border": line, "sideBar.border": line, "titleBar.border": line });
  if (accent) Object.assign(colorCustomizations, { "focusBorder": accent, "button.background": accent });
  return {
    colorTheme: luminance(bg) > 0.55 ? "Default Light Modern" : "Default Dark Modern",
    colorCustomizations,
  };
}

async function ensureRecentVSCodeServer(workspaceId: string): Promise<void> {
  const cached = serverChecks.get(workspaceId);
  if (cached && Date.now() - cached.checkedAt < serverCheckTtlMs) {
    await cached.promise;
    return;
  }
  const promise = ensureWorkspaceVSCodeServer(workspaceId).catch((error) => {
    serverChecks.delete(workspaceId);
    throw error;
  });
  serverChecks.set(workspaceId, { promise, checkedAt: Date.now() });
  await promise;
}

export async function patchVSCodeWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request): Promise<Response> {
  if (app.appKey !== vscodeAppKey || !response.ok) return response;
  if (!response.headers.get("content-type")?.includes("text/html")) return response;
  const requestUrl = new URL(request.url);
  const file = requestUrl.searchParams.get("atelierOpenFile");
  if (file !== null) {
    await response.body?.cancel();
    if (!file.startsWith("/")) return new Response("File path must be absolute", { status: 422 });
    const origin = new URL(publicWorkspaceAppOrigin(request));
    const resource = new URL(`vscode-remote://${origin.host}`);
    resource.pathname = pathToFileURL(file).pathname;
    const payload = [["openFile", resource.href]];
    if (requestUrl.searchParams.get("atelierGotoLine") === "1") payload.push(["gotoLineMode", "true"]);
    const destination = new URL(requestUrl.pathname + requestUrl.search, origin);
    destination.searchParams.delete("atelierOpenFile");
    destination.searchParams.delete("atelierGotoLine");
    destination.searchParams.set("payload", JSON.stringify(payload));
    return new Response(null, { status: 302, headers: { location: destination.href, "cache-control": "no-store" } });
  }
  const themeDefaults = themeDefaultsForRequest(request);
  const text = await response.text();
  const configPattern = /(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]+)(">)/;
  if (!configPattern.test(text)) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  const themed = text.replace(configPattern, (_match, prefix, rawSettings, suffix) => {
    const parsed: unknown = JSON.parse(unescapeHtmlAttribute(rawSettings));
    if (!isJsonObject(parsed)) throw new Error("VS Code workbench configuration is not a JSON object");
    const settings = parsed;
    // VS Code's browser connection settings belong to this adapter, not to the
    // app-facing Host policy. Keep them pointed at the actual preview endpoint.
    const publicOrigin = new URL(publicWorkspaceAppOrigin(request));
    const localAuthority = Value.Parse(remoteAuthoritySchema, settings.remoteAuthority);
    settings.remoteAuthority = publicOrigin.host;
    for (const name of ["workspaceUri", "folderUri"]) {
      const uri = settings[name];
      if (isJsonObject(uri) && uri.scheme === "vscode-remote" && uri.authority === localAuthority) uri.authority = publicOrigin.host;
    }
    const product = settings.productConfiguration;
    const gallery = isJsonObject(product) ? product.extensionsGallery : undefined;
    if (isJsonObject(gallery)) {
      const { resourceUrlTemplate } = Value.Parse(gallerySchema, gallery);
      const localPrefix = `http://${localAuthority}/`;
      if (resourceUrlTemplate?.startsWith(localPrefix)) gallery.resourceUrlTemplate = `${publicOrigin.origin}/${resourceUrlTemplate.slice(localPrefix.length)}`;
    }
    settings.enableWorkspaceTrust = false;
    const configurationDefaults = isJsonObject(settings.configurationDefaults) ? settings.configurationDefaults : {};
    Object.assign(configurationDefaults, {
      "security.workspace.trust.enabled": false,
      "security.workspace.trust.startupPrompt": "never",
      "security.workspace.trust.banner": "never",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.startupEditor": "none",
      "chat.disableAIFeatures": true,
    });
    if (themeDefaults) {
      configurationDefaults["workbench.colorTheme"] = themeDefaults.colorTheme;
      configurationDefaults["workbench.colorCustomizations"] = themeDefaults.colorCustomizations;
    }
    settings.configurationDefaults = configurationDefaults;
    return `${prefix}${escapeHtmlAttribute(JSON.stringify(settings))}${suffix}`;
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(themed, { status: response.status, statusText: response.statusText, headers });
}

export async function resolveVSCodeWorkspaceAppBackend(app: WorkspaceAppHost, requestUrl: URL): Promise<WorkspaceHttpAppBackend> {
  if (app.appKey !== vscodeAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureRecentVSCodeServer(app.workspaceId);
  const targetUrl = new URL(requestUrl.pathname + requestUrl.search, "http://atelier.local");
  [...targetUrl.searchParams.keys()].forEach((key) => {
    if (key.startsWith("atelier")) targetUrl.searchParams.delete(key);
  });
  const path = targetUrl.pathname + targetUrl.search;
  return await workspacePortBackend(app.workspaceId, workspaceVSCodePort, path);
}
