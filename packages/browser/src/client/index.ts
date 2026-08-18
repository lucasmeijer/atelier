/// <reference lib="dom" />

import type { WorkspaceClientControllerConstructor, WorkspaceClientModule } from "@atelier/shared";

type BrowserBridgeLocationMessage = {
  type: "atelier:browser-location";
  href: string;
};

function createBrowserAddressController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class BrowserAddressController extends Controller {
    static values = { targetOrigin: String };

    declare readonly element: HTMLFormElement;
    declare readonly targetOriginValue: string;
    declare readonly hasTargetOriginValue: boolean;

    private readonly onWindowMessage = (event: MessageEvent): void => this.message(event);
    private persistTimer: ReturnType<typeof setTimeout> | undefined;

    connect(): void {
      window.addEventListener("message", this.onWindowMessage);
      this.updateExternalLink();
    }

    disconnect(): void {
      window.removeEventListener("message", this.onWindowMessage);
      if (this.persistTimer) clearTimeout(this.persistTimer);
    }

    submit(): void {
      const input = this.input();
      if (!input) return;
      input.value = normalizeBrowserInput(input.value);
    }

    back(event?: Event): void {
      event?.preventDefault();
      this.sendCommand("back");
    }

    forward(event?: Event): void {
      event?.preventDefault();
      this.sendCommand("forward");
    }

    reload(event?: Event): void {
      event?.preventDefault();
      if (!this.sendCommand("reload")) this.iframe()?.contentWindow?.location.reload();
    }

    private message(event: MessageEvent): void {
      const iframe = this.iframe();
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow) return;
      if (!this.isTrustedFrameOrigin(event.origin, iframe)) return;
      if (!isBrowserBridgeLocationMessage(event.data)) return;
      this.setLocationFromFrame(event.data);
    }

    private setLocationFromFrame(message: BrowserBridgeLocationMessage): void {
      const input = this.input();
      if (!input) return;
      const mapped = mapProxyUrlToBrowserUrl(message.href, this.targetOrigin());
      if (!mapped || input.value === mapped) return;
      input.value = mapped;
      this.updateExternalLink(message.href);
      this.persist(mapped);
    }

    private sendCommand(command: "back" | "forward" | "reload"): boolean {
      const iframe = this.iframe();
      if (!iframe?.contentWindow) return false;
      iframe.contentWindow.postMessage({ type: "atelier:browser-command", command }, this.frameOrigin(iframe) ?? "*");
      return true;
    }

    private persist(url: string): void {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => {
        const body = new URLSearchParams({ url });
        fetch(this.element.action, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          credentials: "same-origin",
        }).catch(() => {});
      }, 120);
    }

    private updateExternalLink(frameHref?: string): void {
      const external = this.element.querySelector<HTMLAnchorElement>(".browser-open-external");
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

    private targetOrigin(): string | undefined {
      if (this.hasTargetOriginValue && this.targetOriginValue) return this.targetOriginValue;
      const current = this.input()?.value;
      if (!current) return undefined;
      try { return new URL(current).origin; } catch { return undefined; }
    }

    private isTrustedFrameOrigin(origin: string, iframe: HTMLIFrameElement): boolean {
      return this.frameOrigin(iframe) === origin;
    }

    private frameOrigin(iframe: HTMLIFrameElement): string | undefined {
      try { return new URL(iframe.src).origin; } catch { return undefined; }
    }
  };
}

function normalizeBrowserInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function mapProxyUrlToBrowserUrl(proxyHref: string, targetOrigin: string | undefined): string | undefined {
  if (!targetOrigin) return undefined;
  try {
    const proxy = new URL(proxyHref);
    stripAtelierBrowserParams(proxy);
    const target = new URL(targetOrigin);
    return new URL(`${proxy.pathname}${proxy.search}${proxy.hash}`, target.origin).toString();
  } catch {
    return undefined;
  }
}

function stripAtelierBrowserParams(url: URL): void {
  url.searchParams.delete("atelierColorScheme");
}

function isBrowserBridgeLocationMessage(value: unknown): value is BrowserBridgeLocationMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // SAFETY: BrowserBridgeLocationMessage only requires the two properties checked below.
  const message = value as { type?: unknown; href?: unknown };
  return message.type === "atelier:browser-location" && typeof message.href === "string";
}

function addAtelierThemeParams(url: URL): void {
  const theme = document.documentElement.dataset.theme || localStorage.getItem("atelier.theme") || "nord";
  url.searchParams.set("atelierColorScheme", theme === "daylight" || theme === "solarized-light" ? "light" : "dark");
}

function isBrowserAppKey(appKey: string): boolean {
  return /^browser-\d+$/.test(appKey);
}

const browserClientModule: WorkspaceClientModule = {
  id: "browser",
  install({ application, Controller, hooks }) {
    application.register("browser-address", createBrowserAddressController(Controller));
    hooks.onWorkspaceAppFrameUrl(({ appKey, frame, url }) => {
      if (isBrowserAppKey(appKey)) addAtelierThemeParams(url);
      frame.closest(".browser-shell")?.querySelector<HTMLAnchorElement>(".browser-open-external")?.setAttribute("href", url.toString());
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (isBrowserAppKey(appKey) && frame.src) load();
    });
  },
};

export { browserClientModule as atelierClientModule };
