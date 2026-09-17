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
        // SAFETY: This form is submitted by its native confirmation button.
        const submit = event.submitter as HTMLButtonElement;
        const buttons = this.element.querySelectorAll<HTMLButtonElement>("button");
        this.errorTarget.hidden = true;
        submit.setAttribute("aria-busy", "true");
        for (const button of buttons) button.disabled = true;

        try {
          const response = await fetch(action, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" }, credentials: "same-origin" });
          if (response.headers.get("x-atelier-reload") === "true") {
            // The app origin now points at the System supervisor, not workspace routes.
            window.location.replace("/");
            return;
          }
          if (!response.headers.get("content-type")?.startsWith("text/vnd.turbo-stream.html")) {
            throw new Error(`Unexpected restart response (HTTP ${response.status} ${response.statusText})`);
          }
          window.Turbo!.renderStreamMessage(await response.text());
        } catch (error) {
          this.errorTarget.textContent = `Could not request the update: ${error instanceof Error ? error.message : String(error)}`;
          this.errorTarget.hidden = false;
          submit.removeAttribute("aria-busy");
          for (const button of buttons) button.disabled = false;
        }
      }
    }

    application.register("update-restart", UpdateRestartController);
  },
};
