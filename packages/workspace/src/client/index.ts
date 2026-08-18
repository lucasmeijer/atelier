/// <reference lib="dom" />

import { createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";

export function createProvisionTerminalController(Controller: new (...args: never[]) => { element: Element }) {
  return class ProvisionTerminalController extends Controller {
    static values = { session: String };
    declare readonly element: HTMLElement;
    declare readonly sessionValue: string;
    private viewer?: ObservableTerminalViewer;

    connect(): void {
      void this.start();
    }

    disconnect(): void {
      this.viewer?.dispose();
      this.viewer = undefined;
    }

    private async start(): Promise<void> {
      if (this.viewer || !this.sessionValue) return;
      this.viewer = await createObservableTerminalViewer({
        host: this.element,
        websocketUrl: observableWebSocketUrl(`/provision-term/${encodeURIComponent(this.sessionValue)}/ws`),
        mode: "fixed-readonly",
        cols: 120,
        rows: 24,
        disconnectedMessage: "\r\n[provision terminal disconnected]\r\n",
        errorMessage: "\r\n[provision terminal websocket error]\r\n",
      });
    }
  };
}
