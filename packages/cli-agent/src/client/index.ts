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
          onConnect: () => this.setConnected(true),
          onDisconnect: () => this.setConnected(false),
        });
      }
      disconnect(): void { this.resize.disconnect(); this.viewer?.dispose(); this.viewer = undefined; }
      private setConnected(connected: boolean): void {
        this.connectionStatusTarget.hidden = connected;
        this.element.setAttribute("data-transcription-composer-unavailable-value", String(!connected));
      }
      dictate(event: CustomEvent<{ text: string }>): void {
        // Treat recognized text as a paste, never as terminal control keys or Enter.
        this.viewer!.paste(event.detail.text.replace(/[\x00-\x1f\x7f-\x9f]/g, " "));
      }
      focus(): void { this.viewer?.focus(); }
      retry(): void {
        // Reinspect session status on explicit retry, not on a polling timer.
        this.element.closest<HTMLElement & { reload(): void }>("turbo-frame")!.reload();
      }
      refresh(): void { this.viewer?.refresh(); }
      theme(): void { this.viewer?.setTheme(atelierObservableTerminalTheme()); }
    });
  },
};
