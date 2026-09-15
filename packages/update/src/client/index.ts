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
      static targets = ["error"];
      declare readonly errorTarget: HTMLElement;
      declare readonly element: HTMLFormElement;
      async submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const action = new URL(this.element.action, window.location.href);
        const submit = this.element.querySelector<HTMLButtonElement>("[data-destructive-confirmation-action]")!;
        const cancel = this.element.querySelector<HTMLButtonElement>("[data-destructive-confirmation-cancel]")!;
        this.errorTarget.hidden = true;
        submit.setAttribute("aria-busy", "true");
        submit.disabled = true;
        cancel.disabled = true;

        try {
          const response = await fetch(action, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" }, credentials: "same-origin" });
          if (response.headers.get("x-atelier-reload") === "true") {
            // The app origin now points at the System supervisor, not workspace routes.
            window.location.replace("/");
            return;
          }
          window.Turbo!.renderStreamMessage(await response.text());
        } catch (error) {
          this.errorTarget.textContent = `Could not request the update: ${error instanceof Error ? error.message : String(error)}`;
          this.errorTarget.hidden = false;
          submit.removeAttribute("aria-busy");
          submit.disabled = false;
          cancel.disabled = false;
        }
      }
    }

    application.register("update-restart", UpdateRestartController);
  },
};
