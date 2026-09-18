/// <reference lib="dom" />

import {
  atelierObservableTerminalTheme,
  createObservableTerminalViewer,
  observableWebSocketUrl,
  type ObservableTerminalViewer,
} from "@atelier/observable-terminal/client";
import { isWorkspacePaneVisible, type WorkspaceClientControllerConstructor, type WorkspaceClientModule } from "@atelier/shared";
import { terminalViewKey } from "../shared.ts";

const terminalAccessoryInput = new Map([
  ["escape", "\x1b"],
  ["up", "\x1b[A"],
  ["down", "\x1b[B"],
  ["right", "\x1b[C"],
  ["left", "\x1b[D"],
]);

export function terminalInputForAccessoryKey(key: string): string {
  const input = terminalAccessoryInput.get(key);
  if (input === undefined) throw new Error(`unknown terminal accessory key: ${key}`);
  return input;
}

export function controlModifiedTerminalInput(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (data === "?") return "\x7f";
  if (data === " ") return "\x00";
  return data;
}

function createTerminalSessionPickerController(Controller: WorkspaceClientControllerConstructor) {
  return class TerminalSessionPickerController extends Controller {
    static targets = ["input", "item"];
    declare readonly inputTarget: HTMLInputElement;
    declare readonly itemTargets: HTMLButtonElement[];

    select(event: Event): void {
      if (!(event.currentTarget instanceof HTMLButtonElement)) throw new Error("terminal session selection must come from a button");
      const session = event.currentTarget.dataset.terminalSession;
      if (!session) throw new Error("terminal session action item is missing its session name");
      this.inputTarget.value = session;
      for (const item of this.itemTargets) item.setAttribute("aria-selected", String(item === event.currentTarget));
    }
  };
}

function createTerminalPaneController(Controller: WorkspaceClientControllerConstructor) {
  return class TerminalPaneController extends Controller {
    static values = { workspaceId: String, id: String };
    static targets = ["connectionStatus", "host", "control"];
    declare readonly hostTarget: HTMLElement;
    declare readonly controlTarget: HTMLButtonElement;
    declare readonly connectionStatusTarget: HTMLElement;
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly idValue: string;
    private readonly viewport = window.visualViewport!;
    private readonly layoutObserver = new ResizeObserver(() => this.syncViewportHeight());
    private terminalTouch?: Touch;
    private pointerDrag?: { id: number; select: boolean };

    private viewer?: ObservableTerminalViewer;
    private controlPending = false;

    start(): void {
      if (!this.viewer) {
        const style = getComputedStyle(this.hostTarget);
        this.viewer = createObservableTerminalViewer({
          host: this.hostTarget,
          mode: "interactive",
          websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/views/${encodeURIComponent(terminalViewKey(this.idValue))}/ws`),
          fontFamily: style.getPropertyValue("--font-mono"),
          fontSize: Number.parseFloat(style.getPropertyValue("--text-code")),
          theme: atelierObservableTerminalTheme(),
          onConnect: () => this.connectionOpened(),
          onDisconnect: () => this.connectionLost(),
          disconnectedMessage: "\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n",
          errorMessage: "\r\n\x1b[31m[terminal websocket error]\x1b[0m\r\n",
          transformInput: (data) => {
            if (!this.controlPending) return data;
            this.setControlPending(false);
            return controlModifiedTerminalInput(data);
          },
        });
      } else {
        this.viewer.reconnect();
        this.viewer.refresh();
      }
      if (document.hasFocus()) this.viewer.focus();
    }

    stop(): void {
      this.viewer?.dispose();
      this.viewer = undefined;
      this.setControlPending(false);
    }

    theme(): void { this.viewer?.setTheme(atelierObservableTerminalTheme()); }

    private setControlPending(pending: boolean): void {
      this.controlPending = pending;
      this.controlTarget.setAttribute("aria-pressed", String(pending));
    }

    readonly syncViewportHeight = (): void => {
      // Keep the accessory row above the keyboard without resizing the app shell.
      // offsetTop matters when the browser pans the visual viewport to the input.
      const bottom = this.viewport.offsetTop + this.viewport.height;
      const height = Math.max(0, bottom - this.element.getBoundingClientRect().top);
      this.element.style.setProperty("--terminal-viewport-height", `${height}px`);
    };

    connect(): void {
      this.viewport.addEventListener("resize", this.syncViewportHeight);
      this.viewport.addEventListener("scroll", this.syncViewportHeight);
      this.layoutObserver.observe(this.element.parentElement!);
      this.syncViewportHeight();
      if (isWorkspacePaneVisible(this.element)) {
        this.start();
      }
    }

    disconnect(): void {
      this.viewport.removeEventListener("resize", this.syncViewportHeight);
      this.viewport.removeEventListener("scroll", this.syncViewportHeight);
      this.layoutObserver.disconnect();
      this.terminalTouch = undefined;
      this.pointerDrag = undefined;
      this.element.style.removeProperty("--terminal-viewport-height");
      this.stop();
    }

    connectionLost(): void { this.connectionStatusTarget.hidden = false; }
    connectionOpened(): void { this.connectionStatusTarget.hidden = true; }
    retry(): void { this.viewer?.reconnect(); }

    startTerminalTouch(event: TouchEvent): void {
      this.terminalTouch = event.touches.length === 1 ? event.touches[0] : undefined;
    }

    moveTerminalTouch(event: TouchEvent): void {
      if (!this.isTerminalTap(event.touches[0]!)) this.cancelTerminalTouch();
    }

    cancelTerminalTouch(): void {
      this.terminalTouch = undefined;
    }

    private isTerminalTap(touch: Touch): boolean {
      const start = this.terminalTouch;
      // Screen coordinates exclude keyboard-induced viewport panning.
      return start !== undefined && touch.identifier === start.identifier
        && Math.hypot(touch.screenX - start.screenX, touch.screenY - start.screenY) <= 10;
    }

    finishTerminalTouch(event: TouchEvent): void {
      const tapped = event.touches.length === 0 && event.changedTouches.length === 1
        && this.isTerminalTap(event.changedTouches[0]!);
      this.cancelTerminalTouch();
      if (!tapped) return;

      // Gespenst focuses on pointerdown. iOS can undo that focus when the native
      // touch finishes on the canvas. Own the completed tap, not blur events:
      // suppress release-time activation and focus within this user gesture.
      event.preventDefault();
      this.viewer?.focus();
    }

    dragPointer(event: PointerEvent): void {
      // Leave touch scrolling/taps and non-primary buttons to Gespenst.
      if (event.pointerType === "touch") return;
      const host = event.currentTarget;
      if (!(host instanceof HTMLElement)) throw new Error("terminal pointer action must come from its host");
      const viewer = this.viewer;
      if (!viewer) return;
      if (event.type === "pointerdown") {
        if (event.button !== 0 || this.pointerDrag) return;
        this.pointerDrag = { id: event.pointerId, select: !event.shiftKey };
        host.setPointerCapture(event.pointerId);
        viewer.focus();
      }
      const drag = this.pointerDrag;
      if (!drag || drag.id !== event.pointerId) return;
      // Capture before Gespenst handles the event so each gesture is sent once.
      event.stopImmediatePropagation();
      event.preventDefault();
      const action = event.type === "pointerdown" ? "press"
        : event.type === "pointermove" ? "motion" : "release";
      viewer.dragPointer(event, action, drag.select);
      if (action === "release") {
        this.pointerDrag = undefined;
        if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      }
    }

    allowNativePaste(event: KeyboardEvent): void {
      // Gespenst otherwise encodes Ctrl+V as terminal input and cancels the
      // browser paste event. Keep Ctrl+C untouched for shell interrupts.
      if (event.ctrlKey && !event.altKey && event.code === "KeyV") event.stopImmediatePropagation();
    }

    preserveTerminalFocus(event: MouseEvent): void {
      if (event.button !== 0) return;
      // Cancel only the focus transfer, not the touch/pointer activation: WebKit
      // can suppress the accessory's native click after a cancelled pointerdown.
      event.preventDefault();
    }

    sendAccessoryKey(event: Event): void {
      if (!(event.currentTarget instanceof HTMLButtonElement)) throw new Error("terminal accessory action must come from a button");
      const key = event.currentTarget.dataset.terminalKey;
      if (!key) throw new Error("terminal accessory button is missing its key");
      const viewer = this.viewer;
      if (key === "control") this.setControlPending(!this.controlPending);
      else viewer?.sendInput(terminalInputForAccessoryKey(key));
      viewer?.focus();
    }
  };
}

export const workspaceTerminalClientModule: WorkspaceClientModule = {
  id: "terminal",
  install({ application, Controller, hooks }) {
    application.register("terminal-pane", createTerminalPaneController(Controller));
    application.register("terminal-session-picker", createTerminalSessionPickerController(Controller));
    const controller = (pane: HTMLElement) => {
      const element = pane.querySelector<HTMLElement>('[data-controller~="terminal-pane"]');
      // SAFETY: This element declares the terminal-pane controller registered immediately above.
      return element ? application.getControllerForElementAndIdentifier(element, "terminal-pane") as { start(): void; stop(): void } | null : null;
    };
    hooks.onBecomeVisible(({ pane }) => controller(pane)?.start());
    hooks.onNoLongerVisible(({ pane }) => controller(pane)?.stop());
  },
};
