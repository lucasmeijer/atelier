/// <reference lib="dom" />

import {
  atelierObservableTerminalTheme,
  createObservableTerminalViewer,
  observableWebSocketUrl,
  type ObservableTerminalTheme,
} from "@atelier/observable-terminal/client";
import { isWorkspacePaneVisible, type WorkspaceClientModule } from "@atelier/shared";
import { terminalViewKey, terminalIdFromViewKey } from "../shared.ts";
import { TerminalViewerRegistry } from "./terminal-viewer-registry.ts";

type StimulusControllerConstructor = new (...args: never[]) => { element: Element };

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

function createTerminalSessionPickerController(Controller: StimulusControllerConstructor) {
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

function createTerminalPaneController(Controller: StimulusControllerConstructor) {
  return class TerminalPaneController extends Controller {
    static values = { workspaceId: String, id: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly idValue: string;
    connect(): void {
      if (isWorkspacePaneVisible(this.element)) {
        void startTerminal(this.workspaceIdValue, this.idValue, { focus: document.hasFocus() });
      }
    }

    disconnect(): void {
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
