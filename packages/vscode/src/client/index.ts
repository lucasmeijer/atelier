/// <reference lib="dom" />

import type { WorkspaceClientModule } from "@atelier/shared";

function currentAtelierTheme(): string {
  const active = document.documentElement.dataset.theme;
  if (active) return active;
  try {
    return localStorage.getItem("atelier.theme") || "nord";
  } catch {
    return "nord";
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

function showStartingForNavigation(frame: HTMLIFrameElement, url: URL): void {
  if (frame.src !== url.toString()) frame.closest(".vscode-frame-shell")?.classList.add("vscode-loading");
}

export const vscodeClientModule: WorkspaceClientModule = {
  id: "vscode",
  install({ application, Controller, hooks }) {
    class VSCodeStartingController extends Controller {
      declare readonly element: HTMLIFrameElement;

      connect(): void {
        this.element.addEventListener("load", this.loaded);
      }

      disconnect(): void {
        this.element.removeEventListener("load", this.loaded);
      }

      private loaded = (): void => {
        this.element.closest(".vscode-frame-shell")?.classList.remove("vscode-loading");
      };
    }

    application.register("vscode-starting", VSCodeStartingController);
    hooks.onWorkspaceAppFrameUrl(({ appKey, url, frame }) => {
      if (appKey !== "vscode") return;
      addAtelierThemeParams(url);
      showStartingForNavigation(frame, url);
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (appKey === "vscode" && frame.src) load();
    });
  },
};

export { vscodeClientModule as atelierClientModule };
