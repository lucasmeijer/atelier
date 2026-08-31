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
        const submit = this.element.querySelector<HTMLButtonElement>(".destructive-confirmation__action")!;
        const cancel = this.element.querySelector<HTMLButtonElement>(".destructive-confirmation__cancel")!;
        const spinner = document.createElement("i");
        spinner.className = "activity-spinner";
        submit.prepend(spinner);
        submit.setAttribute("aria-busy", "true");
        submit.disabled = true;
        cancel.disabled = true;

        try {
          const response = await fetch(action, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" }, credentials: "same-origin" });
          const location = response.headers.get("location");
          if (location) {
            window.location.href = new URL(location, window.location.href).toString();
            return;
          }
          window.Turbo!.renderStreamMessage(await response.text());
        } catch {
          spinner.remove();
          submit.removeAttribute("aria-busy");
          submit.disabled = false;
          cancel.disabled = false;
        }
      }
    }

    application.register("update-restart", UpdateRestartController);
  },
};
