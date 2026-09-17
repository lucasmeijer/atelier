import { Controller } from "@hotwired/stimulus";
import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

class HostTerminalController extends Controller<HTMLElement> {
  static values = { url: String };
  declare urlValue: string;
  private viewer?: ObservableTerminalViewer;
  private generation = 0;
  private theme = new MutationObserver(() => this.viewer?.setTheme(atelierObservableTerminalTheme()));
  connect() {
    const generation = ++this.generation;
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const typography = getComputedStyle(this.element);
    void createObservableTerminalViewer({ host: this.element, fontSize: Number.parseFloat(typography.fontSize), fontFamily: typography.fontFamily, websocketUrl: observableWebSocketUrl(this.urlValue), mode: "interactive", theme: atelierObservableTerminalTheme(), disconnectedMessage: "\r\n[Disconnected. Reopen the Host panel to resume this terminal.]\r\n", errorMessage: "\r\n[Host connection failed.]\r\n" }).then(viewer => {
      if (generation !== this.generation) { viewer.dispose(); return; }
      this.viewer = viewer;
      viewer.refresh();
    }).catch(error => { console.error("Host terminal failed", error); this.element.textContent = "Terminal failed to initialize. Reopen the Host panel to try again."; });
  }
  disconnect() { this.generation++; this.theme.disconnect(); this.viewer?.dispose(); this.viewer = undefined; }
}
class HostPanelController extends Controller<HTMLDialogElement> {
  closed() {
    // Remove terminal viewers and their attachments; detached System tmux owns the processes.
    this.element.remove();
  }
}
class HostDismissController extends Controller<HTMLElement> { dismiss() { this.element.remove(); } }
export const atelierClientModule: WorkspaceClientModule = {
  id: "host",
  install({ application }) {
    application.register("host-terminal", HostTerminalController);
    application.register("host-panel", HostPanelController);
    application.register("host-dismiss", HostDismissController);
  },
};
