import type { WorkspaceClientModule } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

const statusMessage = Type.Object({
  type: Type.Literal("atelier:desktop:status"),
  token: Type.String(),
  phase: Type.Union(["connecting", "connected", "disconnected", "starting", "stopped", "failed"].map(phase => Type.Literal(phase))),
  detail: Type.String(),
});

export const atelierClientModule: WorkspaceClientModule = {
  id: "desktop",
  install({ application, Controller, hooks }) {
    class DesktopPaneController extends Controller {
      static targets = ["frame", "fullscreen", "status", "detail"];
      declare readonly frameTarget: HTMLIFrameElement;
      declare readonly fullscreenTarget: HTMLButtonElement;
      declare readonly statusTargets: HTMLElement[];
      declare readonly detailTarget: HTMLElement;
      private viewerOrigin?: string;

      connect(): void {
        this.fullscreenTarget.hidden = !document.fullscreenEnabled;
        this.fullscreenChanged();
        this.loaded();
      }

      reset(): void {
        this.viewerOrigin = undefined;
        this.show("connecting", "");
      }

      loaded(): void {
        this.reset();
        // The canonical iframe URL redirects to an assigned ingress origin.
        // This non-sensitive request discovers it; replies must prove possession
        // of the per-frame token before we pin and check that origin.
        this.frameTarget.contentWindow?.postMessage({ type: "atelier:desktop:status-request" }, "*");
      }

      receive(event: MessageEvent): void {
        const data = event.data;
        if (event.source !== this.frameTarget.contentWindow || event.origin === "null") return;
        if (!Value.Check(statusMessage, data) || !this.frameTarget.dataset.statusToken || data.token !== this.frameTarget.dataset.statusToken) return;
        if (this.viewerOrigin && event.origin !== this.viewerOrigin) return;
        this.viewerOrigin = event.origin;
        this.show(data.phase, data.detail);
      }

      async toggleFullscreen(): Promise<void> {
        if (document.fullscreenElement === this.element) await document.exitFullscreen();
        else await this.element.requestFullscreen();
      }

      fullscreenChanged(): void {
        this.fullscreenTarget.setAttribute("aria-pressed", String(document.fullscreenElement === this.element));
      }

      private show(phase: string, detail: string): void {
        for (const status of this.statusTargets) status.hidden = status.dataset.phase !== phase;
        this.detailTarget.textContent = detail;
      }
    }
    application.register("desktop-pane", DesktopPaneController);
    hooks.onWorkspaceAppFrameUrl(({ appKey, url, frame }) => {
      if (appKey !== "desktop") return;
      url.searchParams.set("theme", document.documentElement.dataset.theme ?? "");
      url.searchParams.set("parentOrigin", window.location.origin);
      url.searchParams.set("statusToken", frame.dataset.statusToken ??= crypto.randomUUID());
      if (frame.src !== url.toString()) frame.dispatchEvent(new CustomEvent("desktop:navigating"));
    });
    hooks.onWorkspaceAppFrameRefresh(({ appKey, frame, load }) => {
      if (appKey === "desktop" && frame.src) load();
    });
  },
};
