import type { WorkspaceClientModule } from "@atelier/shared";

export const atelierClientModule: WorkspaceClientModule = {
  id: "atelier-update",
  install({ application, Controller }) {
    class UpdateRestartController extends Controller {
      declare readonly element: HTMLFormElement;
      submit(event: SubmitEvent): void {
        const theme = document.documentElement.dataset.theme ?? localStorage.getItem("atelier.theme") ?? "";
        const action = new URL(this.element.action, window.location.href);
        if (theme) action.searchParams.set("theme", theme);
        this.element.action = action.toString();
        const button = event.submitter instanceof HTMLButtonElement ? event.submitter : this.element.querySelector("button[type=submit]");
        button?.setAttribute("disabled", "true");
      }
    }

    class UpdateProgressController extends Controller {
      private source: EventSource | undefined;
      connect(): void {
        if (this.element.getAttribute("data-update-state") !== "pulling") return;
        this.source = new EventSource("/update/events");
        this.source.addEventListener("message", (event) => this.updateProgress(event));
      }
      disconnect(): void {
        this.source?.close();
      }
      private updateProgress(event: MessageEvent): void {
        const json = JSON.parse(event.data) as { percent?: number; state?: string };
        const bar = this.element.querySelector<HTMLElement>(".update-sidebar-progress span");
        if (bar && typeof json.percent === "number") bar.style.width = `${json.percent}%`;
        if (json.state && json.state !== "pulling") this.source?.close();
      }
    }

    application.register("update-restart", UpdateRestartController);
    application.register("update-progress", UpdateProgressController);
  },
};
