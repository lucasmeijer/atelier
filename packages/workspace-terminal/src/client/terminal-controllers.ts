/// <reference lib="dom" />

import {
  applyObservableTerminalChromeTheme,
  atelierObservableTerminalTheme,
  createObservableTerminalViewer,
  DEFAULT_OBSERVABLE_TERMINAL_THEME,
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
let terminalThemeInitialized = false;
let currentTerminalTheme: ObservableTerminalTheme = DEFAULT_OBSERVABLE_TERMINAL_THEME;

function terminalKey(workspaceId: string, terminalId: string): string {
  return `${workspaceId}\u0000${terminalId}`;
}

function applyTerminalTheme(): void {
  currentTerminalTheme = atelierObservableTerminalTheme();
  applyObservableTerminalChromeTheme(currentTerminalTheme);
  for (const terminal of terminals.values()) terminal.setTheme(currentTerminalTheme);
}

function initializeTerminalTheme(): void {
  applyTerminalTheme();
  if (terminalThemeInitialized) return;
  terminalThemeInitialized = true;
  document.addEventListener("atelier:theme-change", applyTerminalTheme);
  new MutationObserver(applyTerminalTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function findTerminalPane(workspaceId: string, terminalId: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(".terminal-pane[data-terminal-id]")).find((candidate) =>
    candidate.dataset.terminalId === terminalId && candidate.dataset.terminalPaneWorkspaceIdValue === workspaceId
  );
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
    if (shouldFocus) viewer.focus();
  } catch (error) {
    startingTerminals.delete(key);
    pendingTerminalFocus.delete(key);
    throw error;
  }
}

function stopTerminal(workspaceId: string, terminalId: string): void {
  const key = terminalKey(workspaceId, terminalId);
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

    connect(): void {
      if (isWorkspacePaneVisible(this.element)) {
        void startTerminal(this.workspaceIdValue, this.idValue, { focus: true });
      }
    }

    disconnect(): void {
      stopTerminal(this.workspaceIdValue, this.idValue);
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
      if (terminalId) void startTerminal(workspaceId, terminalId);
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
