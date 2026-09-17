import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const atelierClientModule: WorkspaceClientModule = {
  id: "codex-agent",
  install({ application, Controller }) {
    application.register("codex-terminal", class extends Controller {
      static values = { url: String };
      static targets = ["terminal"];
      declare readonly element: HTMLElement;
      declare readonly urlValue: string;
      declare readonly terminalTarget: HTMLElement;
      declare readonly hasTerminalTarget: boolean;
      private viewer?: ObservableTerminalViewer;
      private generation = 0;
      private resize = new ResizeObserver(() => this.refresh());

      connect(): void { if (this.hasTerminalTarget) { this.resize.observe(this.terminalTarget); void this.start(); } }
      disconnect(): void { this.generation++; this.resize.disconnect(); this.viewer?.dispose(); }
      private async start(): Promise<void> {
        const generation = ++this.generation;
        const viewer = await createObservableTerminalViewer({ host: this.terminalTarget, mode: "interactive", websocketUrl: observableWebSocketUrl(`${this.urlValue}/ws`), theme: atelierObservableTerminalTheme(), onDisconnect: () => { void this.connectionClosed(); } });
        if (generation !== this.generation) { viewer.dispose(); return; }
        this.viewer = viewer;
      }
      private async connectionClosed(): Promise<void> {
        const response = await fetch(`${this.urlValue}/status`, { headers: { Accept: "text/vnd.turbo-stream.html" } });
        if (!response.ok) throw new Error(`Could not inspect Codex session (${response.status})`);
        window.Turbo!.renderStreamMessage(await response.text());
      }
      retry(): void {
        const frame = this.element.closest<HTMLElement & { reload(): void }>("turbo-frame")!;
        frame.reload();
      }
      refresh(): void { this.viewer?.refresh(); }
      theme(): void { this.viewer?.setTheme(atelierObservableTerminalTheme()); }
    });
  },
};
