/// <reference lib="dom" />

import {
  atelierObservableTerminalTheme,
  createObservableTerminalViewer,
  observableWebSocketUrl,
  type ObservableTerminalTheme,
} from "@atelier/observable-terminal/client";
import { isWorkspacePaneVisible, type WorkspaceClientControllerConstructor, type WorkspaceClientModule } from "@atelier/shared";
import { terminalViewKey, terminalIdFromViewKey } from "../shared.ts";
import { TerminalViewerRegistry } from "./terminal-viewer-registry.ts";

const terminals = new TerminalViewerRegistry();
const pendingTerminalControl = new Set<string>();
let currentTerminalTheme: ObservableTerminalTheme;

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

function terminalKey(workspaceId: string, terminalId: string): string {
  return `${workspaceId}\u0000${terminalId}`;
}

function applyTerminalTheme(): void {
  currentTerminalTheme = atelierObservableTerminalTheme();
  terminals.setTheme(currentTerminalTheme);
}

function initializeTerminalTheme(): void {
  applyTerminalTheme();
  document.addEventListener("atelier:theme-change", applyTerminalTheme);
}

function findTerminalPane(workspaceId: string, terminalId: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(".terminal-pane[data-terminal-id]")).find((candidate) =>
    candidate.dataset.terminalId === terminalId && candidate.dataset.terminalPaneWorkspaceIdValue === workspaceId
  );
}

function setTerminalControlPending(workspaceId: string, terminalId: string, pending: boolean): void {
  const key = terminalKey(workspaceId, terminalId);
  if (pending) pendingTerminalControl.add(key);
  else pendingTerminalControl.delete(key);
  const button = findTerminalPane(workspaceId, terminalId)?.querySelector('[data-terminal-key="control"]');
  button?.setAttribute("aria-pressed", String(pending));
}

function transformTerminalInput(workspaceId: string, terminalId: string, data: string): string {
  const key = terminalKey(workspaceId, terminalId);
  if (!pendingTerminalControl.has(key)) return data;
  setTerminalControlPending(workspaceId, terminalId, false);
  return controlModifiedTerminalInput(data);
}

async function startTerminal(workspaceId: string, terminalId: string, options: { focus?: boolean } = {}): Promise<void> {
  const focus = options.focus !== false;
  const key = terminalKey(workspaceId, terminalId);
  const pane = findTerminalPane(workspaceId, terminalId);
  const host = pane?.querySelector<HTMLElement>(".observable-terminal-host");
  if (!host) return;

  const existing = terminals.active(key);
  if (existing) {
    existing.refresh();
    if (focus) existing.focus();
    return;
  }
  const viewId = terminalViewKey(terminalId);
  const style = getComputedStyle(host);
  const viewer = await terminals.start(key, () => createObservableTerminalViewer({
    host,
    mode: "interactive",
    websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(workspaceId)}/views/${encodeURIComponent(viewId)}/ws`),
    fontFamily: style.getPropertyValue("--font-mono"),
    fontSize: Number.parseFloat(style.getPropertyValue("--text-code")),
    theme: currentTerminalTheme,
    disconnectedMessage: "\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n",
    errorMessage: "\r\n\x1b[31m[terminal websocket error]\x1b[0m\r\n",
    transformInput: (data) => transformTerminalInput(workspaceId, terminalId, data),
  }));
  if (!viewer) return;
  if (!host.isConnected) {
    terminals.cancel(key);
    return;
  }
  if (focus && document.hasFocus()) viewer.focus();
}

function stopTerminal(workspaceId: string, terminalId: string): void {
  const key = terminalKey(workspaceId, terminalId);
  setTerminalControlPending(workspaceId, terminalId, false);
  terminals.cancel(key);
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
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly idValue: string;
    private readonly viewport = window.visualViewport!;
    private readonly layoutObserver = new ResizeObserver(() => this.syncViewportHeight());
    private terminalTouch?: Touch;

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
        void startTerminal(this.workspaceIdValue, this.idValue, { focus: document.hasFocus() });
      }
    }

    disconnect(): void {
      this.viewport.removeEventListener("resize", this.syncViewportHeight);
      this.viewport.removeEventListener("scroll", this.syncViewportHeight);
      this.layoutObserver.disconnect();
      this.terminalTouch = undefined;
      this.element.style.removeProperty("--terminal-viewport-height");
      stopTerminal(this.workspaceIdValue, this.idValue);
    }

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
      terminals.active(terminalKey(this.workspaceIdValue, this.idValue))?.focus();
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
      const terminal = terminalKey(this.workspaceIdValue, this.idValue);
      const viewer = terminals.active(terminal);
      if (key === "control") setTerminalControlPending(this.workspaceIdValue, this.idValue, !pendingTerminalControl.has(terminal));
      else viewer?.sendInput(terminalInputForAccessoryKey(key));
      viewer?.focus();
    }
  };
}

export const workspaceTerminalClientModule: WorkspaceClientModule = {
  id: "terminal",
  install({ application, Controller, hooks }) {
    initializeTerminalTheme();
    application.register("terminal-pane", createTerminalPaneController(Controller));
    application.register("terminal-session-picker", createTerminalSessionPickerController(Controller));
    hooks.onBecomeVisible(({ workspaceId, surfaceKey }) => {
      const terminalId = terminalIdFromViewKey(surfaceKey);
      if (terminalId) void startTerminal(workspaceId, terminalId, { focus: document.hasFocus() });
    });
    hooks.onNoLongerVisible(({ workspaceId, surfaceKey }) => {
      const terminalId = terminalIdFromViewKey(surfaceKey);
      if (terminalId) stopTerminal(workspaceId, terminalId);
    });
  },
};
