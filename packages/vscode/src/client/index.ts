/// <reference lib="dom" />

import type { WorkspaceClientModule } from "@atelier/shared";

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function addAtelierThemeParams(url: URL): void {
  url.searchParams.set("atelierBg", cssVariable("--bg"));
  url.searchParams.set("atelierPanel", cssVariable("--panel"));
  url.searchParams.set("atelierElev", cssVariable("--elev"));
  url.searchParams.set("atelierText", cssVariable("--text"));
  url.searchParams.set("atelierLine", cssVariable("--line"));
  url.searchParams.set("atelierAccent", cssVariable("--accent"));
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

    class VSCodeNavigateController extends Controller {
      static values = { paneId: String, path: String };
      declare readonly paneIdValue: string;
      declare readonly pathValue: string;
      private observer?: MutationObserver;

      connect(): void {
        // The presentation stream activates the pane; its body may still be loading.
        this.observer = new MutationObserver(() => this.navigate());
        this.observer.observe(document.body, { childList: true, subtree: true });
        this.navigate();
      }

      disconnect(): void {
        this.observer?.disconnect();
      }

      private navigate(): void {
        const frame = document.getElementById(this.paneIdValue)?.querySelector("iframe");
        if (!frame) return;
        this.observer!.disconnect();
        // Navigate the existing frame, rather than removing it, so VS Code can
        // run its normal shutdown/backup handling for unsaved editors.
        frame.setAttribute("data-workspace-app-frame-initial-path-value", this.pathValue);
      }
    }

    application.register("vscode-navigate", VSCodeNavigateController);
    application.register("vscode-starting", VSCodeStartingController);
    hooks.onWorkspaceAppFrameUrl(({ appKey, url }) => {
      if (appKey !== "vscode") return;
      addAtelierThemeParams(url);
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (appKey === "vscode" && frame.src) load();
    });
  },
};

export { vscodeClientModule as atelierClientModule };
