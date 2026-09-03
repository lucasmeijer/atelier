import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalTheme, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import { findAgentPaneController } from "./agent-pane.ts";
import type { WorkspaceClientApplication as StimulusApplication, WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function forwardAgentTerminalWheel<T extends Pick<HTMLElement, "scrollTop" | "clientHeight">>(
  terminal: { closest(selectors: string): T | null },
  event: Pick<WheelEvent, "ctrlKey" | "deltaY" | "deltaMode" | "preventDefault" | "stopPropagation"> & {
    readonly DOM_DELTA_LINE: number;
    readonly DOM_DELTA_PAGE: number;
  },
): boolean {
  const transcript = terminal.closest(".agent-transcript");
  if (!transcript || event.ctrlKey || event.deltaY === 0) return false;
  const delta = event.deltaMode === event.DOM_DELTA_LINE
    ? event.deltaY * 16
    : event.deltaMode === event.DOM_DELTA_PAGE
      ? event.deltaY * transcript.clientHeight
      : event.deltaY;
  transcript.scrollTop += delta;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function terminalOutputHasPrintableText(text: string): boolean {
  const withoutEscapeSequences = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g, "");
  return Boolean(withoutEscapeSequences.replace(/[\x00-\x1f\x7f]/g, "").trim());
}

export function createAgentTermController(Controller: StimulusControllerConstructor) {
  return class AgentTermController extends Controller {
    static values = { workspaceId: String, session: String };
    declare readonly element: HTMLElement;
    declare readonly application: StimulusApplication;
    declare readonly workspaceIdValue: string;
    declare readonly sessionValue: string;
    private viewer?: ObservableTerminalViewer;
    private running = false;
    private starting = false;

    private theme(): ObservableTerminalTheme {
      const terminalStyle = getComputedStyle(this.element);
      return {
        ...atelierObservableTerminalTheme(),
        background: terminalStyle.backgroundColor,
        foreground: terminalStyle.color,
      };
    }

    private themeChanged = (): void => {
      this.viewer?.setTheme(this.theme());
    };

    private wheel = (event: WheelEvent): void => {
      forwardAgentTerminalWheel(this.element, event);
    };

    connect(): void {
      document.addEventListener("atelier:theme-change", this.themeChanged);
      this.element.addEventListener("wheel", this.wheel, { capture: true, passive: false });
      findAgentPaneController(this.application, this.element)?.terminalConnected(this);
    }

    start(): void {
      this.running = true;
      if (this.viewer || this.starting) return;
      this.starting = true;
      const style = getComputedStyle(this.element);
      const region = this.element.closest<HTMLElement>(".agent-bash-output")!;
      void createObservableTerminalViewer({
        host: this.element,
        mode: "fixed-readonly",
        cols: 120,
        rows: 30,
        websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agent-term/${encodeURIComponent(this.sessionValue)}/ws?cols=120&rows=30`),
        fontFamily: style.getPropertyValue("--font-mono"),
        fontSize: Number.parseFloat(style.getPropertyValue("--text-code")),
        theme: this.theme(),
        onOutput: (text) => {
          if (region.classList.contains("agent-terminal-awaiting-output") && terminalOutputHasPrintableText(text)) {
            region.classList.remove("agent-terminal-awaiting-output");
          }
        },
      })
        .then((viewer) => {
          if (!this.running) viewer.dispose();
          else this.viewer = viewer;
        })
        // Terminal startup crosses browser and extension APIs that may reject with
        // arbitrary values. This final UI boundary converts the reason to inert text.
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- No Error shape is assumed.
        .catch((error: unknown) => {
          this.element.textContent = `[terminal attach failed: ${error instanceof Error ? error.message : String(error)}]`;
        })
        .finally(() => {
          this.starting = false;
        });
    }

    stop(): void {
      this.running = false;
      this.viewer?.dispose();
      this.viewer = undefined;
    }

    disconnect(): void {
      this.stop();
      document.removeEventListener("atelier:theme-change", this.themeChanged);
      this.element.removeEventListener("wheel", this.wheel, { capture: true });
    }
  };
}

