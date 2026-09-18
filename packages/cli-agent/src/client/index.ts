import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const atelierClientModule: WorkspaceClientModule = {
  id: "cli-agent",
  install({ application, Controller }) {
    application.register("cli-terminal", class extends Controller {
      static values = { url: String };
      static targets = ["terminal"];
      declare readonly element: HTMLElement;
      declare readonly urlValue: string;
      declare readonly terminalTarget: HTMLElement;
      declare readonly hasTerminalTarget: boolean;
      private viewer?: ObservableTerminalViewer;
      private generation = 0;
      private statusRequest = 0;
      private statusTimer?: ReturnType<typeof setInterval>;
      private resize = new ResizeObserver(() => this.refresh());

      connect(): void { if (this.hasTerminalTarget) { this.resize.observe(this.terminalTarget); void this.start(); } }
      disconnect(): void { this.generation++; clearInterval(this.statusTimer); this.resize.disconnect(); this.viewer?.dispose(); this.viewer = undefined; }
      private async start(): Promise<void> {
        const generation = ++this.generation;
        const viewer = await createObservableTerminalViewer({ host: this.terminalTarget, mode: "interactive", websocketUrl: observableWebSocketUrl(`${this.urlValue}/ws`), theme: atelierObservableTerminalTheme(), onDisconnect: () => { if (generation === this.generation) void this.updateStatus(true); } });
        if (generation !== this.generation) { viewer.dispose(); return; }
        this.viewer = viewer;
        this.statusTimer = setInterval(() => { void this.updateStatus(); }, 5000);
      }
      private async updateStatus(disconnected = false): Promise<void> {
        if (disconnected) clearInterval(this.statusTimer);
        const generation = this.generation;
        const request = ++this.statusRequest;
        const response = await fetch(`${this.urlValue}/status${disconnected ? "?disconnected" : ""}`, { headers: { Accept: "text/vnd.turbo-stream.html" } });
        if (!response.ok) throw new Error(`Could not inspect CLI agent session (${response.status})`);
        const stream = await response.text();
        if (generation !== this.generation || request !== this.statusRequest) return;
        if (response.headers.get("X-CLI-Agent-Ended") === "true") clearInterval(this.statusTimer);
        if (this.element.isConnected) window.Turbo!.renderStreamMessage(stream);
      }
      retry(): void {
        if (this.viewer) {
          this.viewer.reconnect();
          clearInterval(this.statusTimer);
          this.statusTimer = setInterval(() => { void this.updateStatus(); }, 5000);
          void this.updateStatus();
          return;
        }
        const frame = this.element.closest<HTMLElement & { reload(): void }>("turbo-frame")!;
        frame.reload();
      }
      refresh(): void { this.viewer?.refresh(); }
      theme(): void { this.viewer?.setTheme(atelierObservableTerminalTheme()); }
    });
  },
};
