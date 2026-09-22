import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, TerminalTouchFocus, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import { isWorkspacePaneVisible, type WorkspaceClientModule } from "@atelier/shared";

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
      private readonly touchFocus = new TerminalTouchFocus(() => this.viewer?.focus());
      private resize = new ResizeObserver(() => this.refresh());

      connect(): void {
        window.addEventListener("atelier:workspace-pane-visible", this.activate);
        this.activate();
      }
      private readonly activate = (): void => {
        if (isWorkspacePaneVisible(this.element)) this.start();
      };
      private start(): void {
        if (!this.hasTerminalTarget || this.viewer) return;
        this.resize.observe(this.terminalTarget);
        this.viewer = createObservableTerminalViewer({
          host: this.terminalTarget, mode: "interactive", websocketUrl: observableWebSocketUrl(`${this.urlValue}/ws`),
          theme: atelierObservableTerminalTheme(),
          onConnect: () => this.setConnected(true),
          onDisconnect: () => this.setConnected(false),
        });
      }
      disconnect(): void { window.removeEventListener("atelier:workspace-pane-visible", this.activate); this.resize.disconnect(); this.touchFocus.cancel(); this.viewer?.dispose(); this.viewer = undefined; }
      startTerminalTouch(event: TouchEvent): void { this.touchFocus.start(event); }
      moveTerminalTouch(event: TouchEvent): void { this.touchFocus.move(event); }
      cancelTerminalTouch(): void { this.touchFocus.cancel(); }
      finishTerminalTouch(event: TouchEvent): void { this.touchFocus.finish(event); }
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
        this.viewer!.reconnect();
      }
      refresh(): void { this.viewer?.refresh(); }
      theme(): void { this.viewer?.setTheme(atelierObservableTerminalTheme()); }
    });
  },
};
