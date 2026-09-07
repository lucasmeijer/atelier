import type { WorkspaceClientControllerConstructor } from "@atelier/shared";

export function createUsageControllers(Controller: WorkspaceClientControllerConstructor) {
  // Provider markup is replaced with composer stats, including after model changes.
  class UsageProviderController extends Controller {
    static values = { provider: String };
    providerValueChanged(): void { this.element.dispatchEvent(new CustomEvent("atelier:usage-provider:changed", { bubbles: true })); }
  }

  class UsageSnapshotController extends Controller {
    connect(): void { this.element.dispatchEvent(new CustomEvent("atelier:usage:refreshed", { bubbles: true })); }
  }

  class UsageButtonController extends Controller {
    declare readonly element: HTMLElement;
    static targets = ["empty"];
    declare readonly emptyTarget: HTMLTemplateElement;
    private provider: string | null = null;
    private request?: AbortController;
    private timer?: ReturnType<typeof setInterval>;
    private readonly recentProviderKey = "atelier:usage-provider";

    connect(): void {
      this.provider = null;
      this.timer = setInterval(this.refresh, 60_000);
      this.selectionChanged();
    }

    disconnect(): void {
      clearInterval(this.timer);
      this.request?.abort();
    }

    selectionChanged(): void {
      // Residency and agent selection events may precede their final class updates.
      queueMicrotask(() => {
        if (!this.element.isConnected) return;
        const resident = document.querySelector(".workspace-detail-resident.visible");
        const marker = resident?.querySelector<HTMLElement>("[data-workspace-pane-role='agent'].is-active [data-usage-provider-provider-value]");
        const provider = (resident ? marker?.dataset.usageProviderProviderValue : sessionStorage.getItem(this.recentProviderKey)) ?? "";
        if (marker) sessionStorage.setItem(this.recentProviderKey, provider);
        if (provider === this.provider) return;
        this.provider = provider;
        // Never display the previous provider while loading the next snapshot.
        this.resetButton();
        this.refresh();
      });
    }

    readonly refresh = async (): Promise<void> => {
      this.request?.abort();
      if (document.hidden) return;
      const request = new AbortController();
      this.request = request;
      const provider = this.provider;
      try {
        const response = await fetch(`/usage/button${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, { signal: request.signal, headers: { Accept: "text/vnd.turbo-stream.html" } });
        if (!response.ok) throw new Error(`Could not refresh Usage button: HTTP ${response.status}`);
        const html = await response.text();
        if (request.signal.aborted) return;
        window.Turbo!.renderStreamMessage(html);
      } catch (error) {
        if (request.signal.aborted) return;
        this.resetButton();
        console.error(error);
      }
    };

    private resetButton(): void {
      this.element.querySelector("turbo-frame")!.replaceChildren(this.emptyTarget.content.cloneNode(true));
    }
  }

  return { "usage-button": UsageButtonController, "usage-provider": UsageProviderController, "usage-snapshot": UsageSnapshotController };
}
