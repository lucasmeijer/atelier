import { Controller } from "@hotwired/stimulus";
import { isWorkspacePaneVisible } from "@atelier/shared";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";
import { clientHooks } from "./workspace-client-hooks.ts";

class WorkspaceAppFrameController extends Controller<HTMLIFrameElement> {
  static values = { workspaceId: String, appKey: String, initialPath: String };
  declare readonly workspaceIdValue: string;
  declare readonly appKeyValue: string;
  declare readonly initialPathValue: string;
  declare readonly hasInitialPathValue: boolean;
  private loadedUrl?: string;
  private pendingLoad?: { url: string; promise: Promise<void> };

  connect(): void {
    document.addEventListener("atelier:theme-change", this.themeChanged);
    if (isWorkspacePaneVisible(this.element)) this.load();
  }

  disconnect(): void {
    document.removeEventListener("atelier:theme-change", this.themeChanged);
  }

  becomeVisible(): void {
    this.load();
  }

  load(): void {
    void this.loadAndWait();
  }

  loadAndWait(): Promise<void> {
    const src = this.frameSrc();
    if (this.loadedUrl === src) return Promise.resolve();
    if (this.pendingLoad?.url === src) return this.pendingLoad.promise;
    if (this.element.src === src && this.element.contentDocument?.readyState === "complete") {
      this.loadedUrl = src;
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve) => {
      this.element.addEventListener("load", () => {
        this.loadedUrl = src;
        this.pendingLoad = undefined;
        resolve();
      }, { once: true });
      if (this.element.src !== src) this.element.src = src;
    });
    this.pendingLoad = { url: src, promise };
    return promise;
  }

  private frameSrc(): string {
    const path = this.hasInitialPathValue && this.initialPathValue ? this.initialPathValue : "/";
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/apps/${encodeURIComponent(this.appKeyValue)}${normalizedPath}`, window.location.href);
    clientHooks.workspaceAppFrameUrl({ appKey: this.appKeyValue, url, frame: this.element });
    return url.toString();
  }

  private themeChanged = (): void => {
    clientHooks.workspaceAppFrameRefresh({ appKey: this.appKeyValue, frame: this.element, load: () => this.load() });
  };
}

export function registerWorkspaceAppFrameController(): void {
  registerWorkspaceControllers({
    "workspace-app-frame": WorkspaceAppFrameController,
  });
}
