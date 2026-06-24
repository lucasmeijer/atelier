/// <reference lib="dom" />

import type { WorkspaceClientModule } from "@atelier/shared";

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };

type BrowserBridgeLocationMessage = {
  type: "atelier:browser-location";
  href: string;
};

type BrowserBridgeStateMessage = {
  type: "atelier:browser-state";
  canGoBack?: boolean;
  canGoForward?: boolean;
};

function createBrowserPaneController(Controller: StimulusControllerConstructor): unknown {
  return class BrowserPaneController extends Controller {
    declare readonly element: HTMLElement;
  };
}

function createBrowserAddressController(Controller: StimulusControllerConstructor): unknown {
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
      if (!isRecord(event.data)) return;

      if (event.data.type === "atelier:browser-location" && typeof event.data.href === "string") {
        this.setLocationFromFrame(event.data as BrowserBridgeLocationMessage);
        return;
      }
      if (event.data.type === "atelier:browser-state") this.setNavState(event.data as BrowserBridgeStateMessage);
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

    private setNavState(_message: BrowserBridgeStateMessage): void {
      // Cross-document iframe history is intentionally opaque to the parent.
      // Keep controls available; a no-op history.back()/forward() is less
      // surprising than disabling a button from incomplete same-document state.
      this.button("back").disabled = false;
      this.button("forward").disabled = false;
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

    private button(action: "back" | "forward"): HTMLButtonElement {
      return this.element.querySelector<HTMLButtonElement>(`[data-action~="browser-address#${action}"]`) ?? document.createElement("button");
    }

    private iframe(): HTMLIFrameElement | null {
      return this.element.closest(".browser-shell")?.querySelector<HTMLIFrameElement>("iframe") ?? null;
    }

    private targetOrigin(): string {
      if (this.hasTargetOriginValue && this.targetOriginValue) return this.targetOriginValue;
      const current = this.input()?.value;
      if (current) {
        try { return new URL(current).origin; } catch {}
      }
      return "http://localhost:3000/";
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
  if (!trimmed) return "http://localhost:3000/";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function mapProxyUrlToBrowserUrl(proxyHref: string, targetOrigin: string): string | undefined {
  try {
    const proxy = new URL(proxyHref);
    const target = new URL(targetOrigin);
    return new URL(`${proxy.pathname}${proxy.search}${proxy.hash}`, target.origin).toString();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const browserClientModule: WorkspaceClientModule = {
  id: "browser",
  install({ application, Controller, hooks }) {
    application.register("browser-pane", createBrowserPaneController(Controller));
    application.register("browser-address", createBrowserAddressController(Controller));
    hooks.onWorkspaceAppFrameUrl(({ frame, url }) => {
      frame.closest(".browser-shell")?.querySelector<HTMLAnchorElement>(".browser-open-external")?.setAttribute("href", url.toString());
    });
  },
};

export { browserClientModule as atelierClientModule };
