import { type WorkspaceClientModule } from "@atelier/shared";

declare global {
  interface Window {
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
        const submit = this.element.querySelector<HTMLButtonElement>("#update_restart_submit")!;
        const cancel = this.element.querySelector<HTMLButtonElement>("[data-update-restart-cancel]")!;
        const status = this.element.querySelector<HTMLElement>("[data-update-restart-status]")!;
        submit.dataset.progressState = "in-progress";
        submit.style.setProperty("--button-progress", "1");
        submit.setAttribute("aria-busy", "true");
        submit.disabled = true;
        cancel.disabled = true;
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
          submit.dataset.progressState = "initial";
          submit.style.setProperty("--button-progress", "0");
          submit.removeAttribute("aria-busy");
          submit.disabled = false;
          cancel.disabled = false;
          status.textContent = "The connection was interrupted. Atelier may still be restarting; wait a few seconds, then try restarting again or refresh this page.";
        }
      }
    }

    application.register("update-restart", UpdateRestartController);
  },
};
