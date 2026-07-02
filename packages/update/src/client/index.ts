import { CableTopics, type AtelierCableClient, type CableIdentifier, type WorkspaceClientModule } from "@atelier/shared";

declare global {
  interface Window {
    AtelierCable?: AtelierCableClient;
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

export const atelierClientModule: WorkspaceClientModule = {
  id: "atelier-update",
  install({ application, Controller }) {
    class UpdateRestartController extends Controller {
      declare readonly element: HTMLFormElement;
      async submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const theme = document.documentElement.dataset.theme ?? localStorage.getItem("atelier.theme") ?? "";
        const action = new URL(this.element.action, window.location.href);
        if (theme) action.searchParams.set("theme", theme);
        const button = event.submitter instanceof HTMLButtonElement ? event.submitter : this.element.querySelector("button[type=submit]");
        button?.setAttribute("disabled", "true");
        const response = await fetch(action, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" }, credentials: "same-origin" });
        const location = response.headers.get("location");
        if (location) {
          window.location.href = new URL(location, window.location.href).toString();
          return;
        }
        const html = await response.text();
        if (html) window.Turbo?.renderStreamMessage(html);
        button?.removeAttribute("disabled");
      }
    }

    class UpdateProgressController extends Controller {
      private subscribed = false;
      private readonly identifier: CableIdentifier = CableTopics.update();
      connect(): void {
        if (this.element.getAttribute("data-update-state") !== "pulling") return;
        window.AtelierCable?.subscribe(this.identifier);
        this.subscribed = true;
      }
      disconnect(): void {
        if (!this.subscribed) return;
        window.AtelierCable?.unsubscribe(this.identifier);
        this.subscribed = false;
      }
    }

    application.register("update-restart", UpdateRestartController);
    application.register("update-progress", UpdateProgressController);
  },
};
