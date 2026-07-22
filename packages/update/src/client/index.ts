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
        const submit = this.element.querySelector<HTMLButtonElement>("[data-update-restart-submit]")!;
        const cancel = this.element.querySelector<HTMLButtonElement>("[data-update-restart-cancel]")!;
        const status = this.element.querySelector<HTMLElement>("[data-update-restart-status]")!;
        submit.disabled = true;
        cancel.disabled = true;
        submit.setAttribute("aria-busy", "true");
        submit.innerHTML = `<span class="status-spinner sm" aria-hidden="true"></span><span>Preparing restart…</span>`;
        status.textContent = "Starting the update helper. This can take a few seconds…";

        try {
          const response = await fetch(action, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" }, credentials: "same-origin" });
          const location = response.headers.get("location");
          if (location) {
            window.location.href = new URL(location, window.location.href).toString();
            return;
          }
          window.Turbo!.renderStreamMessage(await response.text());
        } catch {
          submit.disabled = false;
          cancel.disabled = false;
          submit.removeAttribute("aria-busy");
          submit.innerHTML = "Retry restart";
          status.textContent = "The connection was interrupted. Atelier may still be restarting; wait a few seconds, then refresh this page.";
        }
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
