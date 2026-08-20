import { isJsonObject } from "@atelier/core";
import { workspacePortUrl, workspaceVSCodePort } from "@atelier/workspace";
import type { WorkspaceAppHost } from "@atelier/proxy-ingress/server";
import { ensureWorkspaceVSCodeServer } from "./workspace-vscode.ts";

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

function vscodeBridgeScript(nonce: string | undefined): string {
  return `<script${nonce ? ` nonce="${escapeHtmlAttribute(nonce)}"` : ""} type="module">
(() => {
  const trustedSource = window.parent;
  async function workbenchCommands() {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (window.__atelierVSCodeCommands) return window.__atelierVSCodeCommands;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("VS Code command bridge did not initialize");
  }
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== trustedSource || !message || message.type !== "atelier.vscode.executeCommand") return;
    try {
      const commands = await workbenchCommands();
      await commands.executeCommand(message.command, ...(message.args || []));
    } catch (error) {
      console.error("Atelier VS Code command failed", error);
    }
  });
})();
</script>`;
}

function patchVSCodeWorkbenchScript(text: string): string {
  const identifier = "([A-Za-z_$][\\w$]*)";
  const commandApiPattern = new RegExp(`async function ${identifier}\\(${identifier},\\.\\.\\.${identifier}\\)\\{return\\(await [A-Za-z_$][\\w$]*\\.p\\)\\.commands\\.executeCommand\\(\\2,\\.\\.\\.\\3\\)\\}${identifier}\\.executeCommand=\\1`);
  const patched = text.replace(commandApiPattern, "$&;globalThis.__atelierVSCodeCommands=$4");
  if (patched === text) throw new Error("could not expose VS Code command bridge");
  return patched;
}

export async function patchVSCodeWorkspaceAppResponse(app: WorkspaceAppHost, response: Response, request: Request): Promise<Response> {
  if (app.appKey !== vscodeAppKey || !response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("javascript") && new URL(request.url).pathname.endsWith("/workbench/workbench.js")) {
    const patchedScript = patchVSCodeWorkbenchScript(await response.text());
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(patchedScript, { status: response.status, statusText: response.statusText, headers });
  }
  if (!contentType.includes("text/html")) return response;
  const themeDefaults = themeDefaultsForRequest(request);
  const text = await response.text();
  const configPattern = /(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]+)(">)/;
  if (!configPattern.test(text)) return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  const themed = text.replace(configPattern, (_match, prefix, rawSettings, suffix) => {
    const parsed: unknown = JSON.parse(unescapeHtmlAttribute(rawSettings));
    if (!isJsonObject(parsed)) throw new Error("VS Code workbench configuration is not a JSON object");
    const settings = parsed;
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
  const nonce = response.headers.get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];
  const bridge = vscodeBridgeScript(nonce);
  const patched = themed.includes("</body>") ? themed.replace("</body>", `${bridge}</body>`) : `${themed}${bridge}`;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
}

export async function resolveVSCodeWorkspaceAppTarget(app: WorkspaceAppHost, requestUrl: URL): Promise<URL> {
  if (app.appKey !== vscodeAppKey) throw new Error(`unknown workspace app: ${app.appKey}`);
  await ensureRecentVSCodeServer(app.workspaceId);
  const targetUrl = new URL(requestUrl.pathname + requestUrl.search, "http://atelier.local");
  [...targetUrl.searchParams.keys()].forEach((key) => {
    if (key.startsWith("atelier")) targetUrl.searchParams.delete(key);
  });
  const path = targetUrl.pathname + targetUrl.search;
  return await workspacePortUrl(app.workspaceId, workspaceVSCodePort, path);
}
