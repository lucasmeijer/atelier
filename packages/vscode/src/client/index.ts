/// <reference lib="dom" />

import type { WorkspaceClientModule } from "@atelier/shared";

function currentAtelierTheme(): string {
  const active = document.documentElement.dataset.theme;
  if (active) return active;
  try {
    return localStorage.getItem("atelier.theme") || "cappuccino";
  } catch {
    return "cappuccino";
  }
}

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function addAtelierThemeParams(url: URL): void {
  url.searchParams.set("atelierTheme", currentAtelierTheme());
  url.searchParams.set("atelierBg", cssVariable("--bg"));
  url.searchParams.set("atelierPanel", cssVariable("--panel"));
  url.searchParams.set("atelierElev", cssVariable("--elev"));
  url.searchParams.set("atelierText", cssVariable("--text"));
  url.searchParams.set("atelierLine", cssVariable("--line"));
  url.searchParams.set("atelierAccent", cssVariable("--accent"));
}

export const vscodeClientModule: WorkspaceClientModule = {
  id: "vscode",
  install({ hooks }) {
    hooks.onWorkspaceAppFrameUrl(({ appKey, url }) => {
      if (appKey === "vscode") addAtelierThemeParams(url);
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (appKey === "vscode" && frame.src) load();
    });
  },
};

export { vscodeClientModule as atelierClientModule };
