import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const atelierClientModule: WorkspaceClientModule = {
  id: "cli-agent",
  install({ application, Controller }) {
    application.register("cli-terminal", class extends Controller {
      static values = { url: String };
      static targets = ["terminal", "connectionStatus"];
      declare readonly element: HTMLElement;
      declare readonly urlValue: string;
      declare readonly terminalTarget: HTMLElement;
      declare readonly connectionStatusTarget: HTMLElement;
      declare readonly hasTerminalTarget: boolean;
      private viewer?: ObservableTerminalViewer;
      private resize = new ResizeObserver(() => this.refresh());

      connect(): void {
        if (!this.hasTerminalTarget) return;
        this.resize.observe(this.terminalTarget);
        this.viewer = createObservableTerminalViewer({
          host: this.terminalTarget, mode: "interactive", websocketUrl: observableWebSocketUrl(`${this.urlValue}/ws`),
          theme: atelierObservableTerminalTheme(),
          onConnect: () => { this.connectionStatusTarget.hidden = true; },
          onDisconnect: () => { this.connectionStatusTarget.hidden = false; },
        });
      }
      disconnect(): void { this.resize.disconnect(); this.viewer?.dispose(); this.viewer = undefined; }
      retry(): void {
        // Reinspect session status on explicit retry, not on a polling timer.
        this.element.closest<HTMLElement & { reload(): void }>("turbo-frame")!.reload();
      }
      refresh(): void { this.viewer?.refresh(); }
      theme(): void { this.viewer?.setTheme(atelierObservableTerminalTheme()); }
    });
  },
};
