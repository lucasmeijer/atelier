/// <reference lib="dom" />

import type { WorkspaceClientControllerConstructor, WorkspaceClientModule } from "@atelier/shared";

function createBrowserAddressController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class BrowserAddressController extends Controller {
    declare readonly element: HTMLFormElement;

    connect(): void {
      this.updateExternalLink();
    }

    initializeAddress(): void {
      const input = this.input();
      if (input && !input.value) input.value = "http://localhost:3000";
    }

    submit(): void {
      const input = this.input();
      if (!input) return;
      input.value = normalizeBrowserInput(input.value);
    }

    reload(event?: Event): void {
      event?.preventDefault();
      const iframe = this.iframe();
      if (iframe?.src) iframe.src = iframe.src;
    }

    private updateExternalLink(frameHref?: string): void {
      const external = this.element.querySelector<HTMLAnchorElement>('[data-browser-address-target="external"]');
      if (!external) return;
      const href = frameHref ?? this.iframe()?.src;
      if (href) external.href = href;
    }

    private input(): HTMLInputElement | null {
      return this.element.querySelector<HTMLInputElement>(".browser-address-input");
    }

    private iframe(): HTMLIFrameElement | null {
      return this.element.closest(".browser-shell")?.querySelector<HTMLIFrameElement>("iframe") ?? null;
    }
  };
}

function normalizeBrowserInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function isBrowserAppKey(appKey: string): boolean {
  return /^browser-[a-zA-Z0-9-]+$/.test(appKey);
}

const browserClientModule: WorkspaceClientModule = {
  id: "browser",
  install({ application, Controller, hooks }) {
    application.register("browser-address", createBrowserAddressController(Controller));
    hooks.onWorkspaceAppFrameUrl(({ frame, url }) => {
      frame.closest(".browser-shell")?.querySelector<HTMLAnchorElement>('[data-browser-address-target="external"]')?.setAttribute("href", url.toString());
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (isBrowserAppKey(appKey) && frame.src) load();
    });
  },
};

export { browserClientModule as atelierClientModule };
