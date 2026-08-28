/// <reference lib="dom" />

import {
  atelierObservableTerminalTheme,
  createObservableTerminalViewer,
  observableWebSocketUrl,
  type ObservableTerminalTheme,
  type ObservableTerminalViewer,
} from "@atelier/observable-terminal/client";
import { isWorkspacePaneVisible, type WorkspaceClientModule } from "@atelier/shared";
import { terminalViewKey, terminalIdFromViewKey } from "../shared.ts";

type StimulusControllerConstructor = new (...args: never[]) => { element: Element };

const terminals = new Map<string, ObservableTerminalViewer>();
const startingTerminals = new Set<string>();
const pendingTerminalFocus = new Set<string>();
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
  for (const terminal of terminals.values()) terminal.setTheme(currentTerminalTheme);
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

  const existing = terminals.get(key);
  if (existing) {
    if (focus) existing.focus();
    existing.fitToHost();
    return;
  }
  if (startingTerminals.has(key)) {
    if (focus) pendingTerminalFocus.add(key);
    return;
  }
  if (focus) pendingTerminalFocus.add(key);
  startingTerminals.add(key);

  try {
    const viewId = terminalViewKey(terminalId);
    const viewer = await createObservableTerminalViewer({
      host,
      mode: "interactive",
      websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(workspaceId)}/views/${encodeURIComponent(viewId)}/ws?cols=80&rows=24`),
      theme: currentTerminalTheme,
      disconnectedMessage: "\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n",
      errorMessage: "\r\n\x1b[31m[terminal websocket error]\x1b[0m\r\n",
      transformInput: (data) => transformTerminalInput(workspaceId, terminalId, data),
    });
    if (!startingTerminals.has(key) || !host.isConnected) {
      viewer.dispose();
      startingTerminals.delete(key);
      pendingTerminalFocus.delete(key);
      return;
    }
    terminals.set(key, viewer);

    startingTerminals.delete(key);
    const shouldFocus = pendingTerminalFocus.delete(key) || focus;
    if (shouldFocus && document.hasFocus()) viewer.focus();
  } catch (error) {
    startingTerminals.delete(key);
    pendingTerminalFocus.delete(key);
    throw error;
  }
}

function stopTerminal(workspaceId: string, terminalId: string): void {
  const key = terminalKey(workspaceId, terminalId);
  setTerminalControlPending(workspaceId, terminalId, false);
  const state = terminals.get(key);
  if (!state) return;
  state.dispose();
  terminals.delete(key);
  startingTerminals.delete(key);
  pendingTerminalFocus.delete(key);
}

function createTerminalPaneController(Controller: StimulusControllerConstructor) {
  return class TerminalPaneController extends Controller {
    static values = { workspaceId: String, id: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly idValue: string;
    private readonly viewport = window.visualViewport ?? window;
    private keyboardRequested = false;
    private keyboardAccessoryVisible = false;

    private readonly requestKeyboardAccessory = (event: TouchEvent): void => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".observable-terminal-host")) return;
      this.keyboardRequested = true;
      requestAnimationFrame(this.syncKeyboardAccessory);
    };

    private updateKeyboardAccessory(visible: boolean): void {
      this.element.classList.toggle("terminal-keyboard-visible", visible);
      if (visible) {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        document.documentElement.classList.add("terminal-mobile-keyboard-visible");
        document.documentElement.style.setProperty("--terminal-keyboard-viewport-height", `${viewportHeight}px`);
      } else if (this.keyboardAccessoryVisible) {
        document.documentElement.classList.remove("terminal-mobile-keyboard-visible");
        document.documentElement.style.removeProperty("--terminal-keyboard-viewport-height");
      }
      this.keyboardAccessoryVisible = visible;
    }

    private readonly syncKeyboardAccessory = (): void => {
      const focused = this.element.contains(document.activeElement) && document.activeElement?.classList.contains("gespenst__input") === true;
      this.updateKeyboardAccessory(this.keyboardRequested && focused);
      if (!focused) this.keyboardRequested = false;
    };

    connect(): void {
      this.element.addEventListener("touchstart", this.requestKeyboardAccessory, { passive: true });
      this.element.addEventListener("focusin", this.syncKeyboardAccessory);
      this.element.addEventListener("focusout", this.syncKeyboardAccessory);
      this.viewport.addEventListener("resize", this.syncKeyboardAccessory);
      if (isWorkspacePaneVisible(this.element)) {
        void startTerminal(this.workspaceIdValue, this.idValue, { focus: document.hasFocus() });
      }
    }

    disconnect(): void {
      this.element.removeEventListener("touchstart", this.requestKeyboardAccessory);
      this.element.removeEventListener("focusin", this.syncKeyboardAccessory);
      this.element.removeEventListener("focusout", this.syncKeyboardAccessory);
      this.viewport.removeEventListener("resize", this.syncKeyboardAccessory);
      this.keyboardRequested = false;
      this.updateKeyboardAccessory(false);
      stopTerminal(this.workspaceIdValue, this.idValue);
    }

    preserveTerminalFocus(event: PointerEvent): void {
      event.preventDefault();
    }

    sendAccessoryKey(event: Event): void {
      if (!(event.currentTarget instanceof HTMLButtonElement)) throw new Error("terminal accessory action must come from a button");
      const key = event.currentTarget.dataset.terminalKey;
      if (!key) throw new Error("terminal accessory button is missing its key");
      const terminal = terminalKey(this.workspaceIdValue, this.idValue);
      const viewer = terminals.get(terminal);
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
    hooks.onBecomeVisible(({ workspaceId, surfaceKey }) => {
      const terminalId = terminalIdFromViewKey(surfaceKey);
      if (terminalId) void startTerminal(workspaceId, terminalId, { focus: document.hasFocus() });
    });
    hooks.onNoLongerVisible(({ workspaceId, surfaceKey }) => {
      const terminalId = terminalIdFromViewKey(surfaceKey);
      if (terminalId) stopTerminal(workspaceId, terminalId);
    });
    hooks.onFocusGroup(({ workspaceId, surfaceKey }) => {
      const terminalId = surfaceKey ? terminalIdFromViewKey(surfaceKey) : undefined;
      if (!workspaceId || !terminalId) return false;
      void startTerminal(workspaceId, terminalId, { focus: true });
      return true;
    });
  },
};
