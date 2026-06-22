/// <reference lib="dom" />

import {
  applyObservableTerminalChromeTheme,
  createObservableTerminalViewer,
  DEFAULT_OBSERVABLE_TERMINAL_THEME,
  observableWebSocketUrl,
  type ObservableTerminalTheme,
  type ObservableTerminalViewer,
} from "@atelier/observable-terminal/client";
import { observableTerminalTabPrefix } from "@atelier/observable-terminal/shared";
import type { WorkspaceClientModule } from "@atelier/shared";

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };

const terminals = new Map<string, ObservableTerminalViewer>();
const startingTerminals = new Set<string>();
const pendingTerminalFocus = new Set<string>();
let terminalThemeInitialized = false;
let currentTerminalTheme: ObservableTerminalTheme = DEFAULT_OBSERVABLE_TERMINAL_THEME;

function terminalKey(workspaceId: string, title: string): string {
  return `${workspaceId}\u0000${title}`;
}

function cssVariable(name: string): string | undefined {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

function themeColor(name: string, fallbackKey: keyof typeof DEFAULT_OBSERVABLE_TERMINAL_THEME): string {
  return cssVariable(name) ?? DEFAULT_OBSERVABLE_TERMINAL_THEME[fallbackKey];
}

function atelierTerminalTheme(): ObservableTerminalTheme {
  const background = themeColor("--bg", "background");
  const foreground = themeColor("--text", "foreground");
  const accent = themeColor("--accent", "brightBlue");
  const red = cssVariable("--red") ?? foreground;
  const green = cssVariable("--green") ?? foreground;
  const amber = cssVariable("--amber") ?? foreground;
  const violet = cssVariable("--violet") ?? accent;
  return {
    background,
    foreground,
    cursor: accent,
    black: themeColor("--panel", "black"),
    red,
    green,
    yellow: amber,
    blue: accent,
    magenta: violet,
    cyan: accent,
    white: foreground,
    brightBlack: themeColor("--line-2", "brightBlack"),
    brightRed: red,
    brightGreen: green,
    brightYellow: amber,
    brightBlue: accent,
    brightMagenta: violet,
    brightCyan: accent,
    brightWhite: foreground,
  };
}

function applyTerminalTheme(): void {
  currentTerminalTheme = atelierTerminalTheme();
  applyObservableTerminalChromeTheme(currentTerminalTheme);
  for (const terminal of terminals.values()) terminal.setTheme(currentTerminalTheme);
}

export function initializeTerminalTheme(): void {
  applyTerminalTheme();
  if (terminalThemeInitialized) return;
  terminalThemeInitialized = true;
  document.addEventListener("atelier:theme-change", applyTerminalTheme);
  new MutationObserver(applyTerminalTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function findTerminalPane(workspaceId: string, title: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>(".terminal-pane[data-terminal-title]")).find((candidate) =>
    candidate.dataset.terminalTitle === title && candidate.dataset.terminalPaneWorkspaceIdValue === workspaceId
  );
}

export async function startTerminal(workspaceId: string, title: string, options: { focus?: boolean } = {}): Promise<void> {
  const focus = options.focus !== false;
  const key = terminalKey(workspaceId, title);
  const pane = findTerminalPane(workspaceId, title);
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
    const tabId = `${observableTerminalTabPrefix}${title}`;
    const viewer = await createObservableTerminalViewer({
      host,
      mode: "interactive",
      websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(tabId)}/ws?cols=80&rows=24`),
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

export function stopTerminal(workspaceId: string, title: string): void {
  const key = terminalKey(workspaceId, title);
  const state = terminals.get(key);
  if (!state) return;
  state.dispose();
  terminals.delete(key);
  startingTerminals.delete(key);
  pendingTerminalFocus.delete(key);
}

export function startTerminalTab(workspaceId: string, tabName: string): void {
  if (tabName.startsWith(observableTerminalTabPrefix)) void startTerminal(workspaceId, tabName.slice(observableTerminalTabPrefix.length));
}

export function createTerminalPaneController(Controller: StimulusControllerConstructor) {
  return class TerminalPaneController extends Controller {
    static values = { workspaceId: String, title: String, autostart: Boolean };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly titleValue: string;
    declare readonly autostartValue: boolean;

    connect(): void {
      const pane = this.element.closest<HTMLElement>(".tab-pane[data-tab-pane]");
      void startTerminal(this.workspaceIdValue, this.titleValue, { focus: this.autostartValue || pane?.classList.contains("active") });
    }

    disconnect(): void {
      stopTerminal(this.workspaceIdValue, this.titleValue);
    }
  };
}

export const workspaceTerminalClientModule: WorkspaceClientModule = {
  id: "terminal",
  install({ application, Controller, hooks }) {
    initializeTerminalTheme();
    application.register("terminal-pane", createTerminalPaneController(Controller));
    hooks.onActivateTab(({ workspaceId, tabKey }) => startTerminalTab(workspaceId, tabKey));
    hooks.onFocusGroup(({ workspaceId, tabKey }) => {
      if (!workspaceId || !tabKey?.startsWith(observableTerminalTabPrefix)) return false;
      void startTerminal(workspaceId, tabKey.slice(observableTerminalTabPrefix.length), { focus: true });
      return true;
    });
  },
};
