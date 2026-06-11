/// <reference lib="dom" />

import { FitAddon } from "@xterm/addon-fit";
import { ProgressAddon } from "@xterm/addon-progress";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";

export interface TerminalState {
  term: Terminal;
  ws: WebSocket;
  fit: FitAddon;
  progressSubscription: { dispose(): void };
  resizeObserver: ResizeObserver;
}

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };
type TerminalTheme = Record<string, string>;

const TERMINAL_THEME = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  black: "#3b4252",
  brightBlack: "#4c566a",
  brightBlue: "#81a1c1",
} as const satisfies TerminalTheme;

const terminals = new Map<string, TerminalState>();
const startingTerminals = new Set<string>();
const pendingTerminalFocus = new Set<string>();

function terminalKey(workspaceId: string, title: string): string {
  return `${workspaceId}\u0000${title}`;
}

function applyTerminalChromeTheme(theme: TerminalTheme): void {
  document.documentElement.style.setProperty("--terminal-bg", theme.background);
  document.documentElement.style.setProperty("--terminal-fg", theme.foreground);
  document.documentElement.style.setProperty("--terminal-cursor", theme.cursor);
  document.documentElement.style.setProperty("--terminal-bar-bg", theme.black);
  document.documentElement.style.setProperty("--terminal-bar-fg", theme.brightBlue ?? theme.foreground);
  document.documentElement.style.setProperty("--terminal-border", theme.brightBlack ?? theme.black);
}

export function initializeTerminalTheme(): void {
  applyTerminalChromeTheme(TERMINAL_THEME);
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
  const host = pane?.querySelector<HTMLElement>(".xterm-terminal");
  if (!host) return;

  const existing = terminals.get(key);
  if (existing) {
    if (focus) existing.term.focus();
    existing.fit.fit();
    return;
  }
  if (startingTerminals.has(key)) {
    if (focus) pendingTerminalFocus.add(key);
    return;
  }
  if (focus) pendingTerminalFocus.add(key);
  startingTerminals.add(key);

  try {
    await document.fonts.load('13px "JetBrains Mono"');
  } catch (error) {
    startingTerminals.delete(key);
    pendingTerminalFocus.delete(key);
    throw error;
  }
  if (terminals.has(key)) {
    startingTerminals.delete(key);
    pendingTerminalFocus.delete(key);
    return;
  }

  try {
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      scrollback: 10000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    const progress = new ProgressAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(progress);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.open(host);
    fit.fit();
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(host);

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const tabId = `terminal:${title}`;
    const ws = new WebSocket(`${protocol}//${location.host}/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(tabId)}/ws?cols=${term.cols}&rows=${term.rows}`);
    const progressSubscription = progress.onChange(({ state, value }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "progress", state, value }));
    });

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    term.onResize((size) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
    });
    ws.onmessage = (event) => {
      if (typeof event.data === "string") term.write(event.data);
      else event.data.arrayBuffer().then((buffer: ArrayBuffer) => term.write(new Uint8Array(buffer)));
    };
    ws.onclose = () => term.write("\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n");
    ws.onerror = () => term.write("\r\n\x1b[31m[terminal websocket error]\x1b[0m\r\n");

    terminals.set(key, { term, ws, fit, progressSubscription, resizeObserver });
    startingTerminals.delete(key);
    const shouldFocus = pendingTerminalFocus.delete(key) || focus;
    if (shouldFocus) term.focus();
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
  state.ws.onclose = null;
  state.ws.onerror = null;
  state.ws.close();
  state.progressSubscription.dispose();
  state.resizeObserver.disconnect();
  state.fit.dispose();
  state.term.dispose();
  terminals.delete(key);
  startingTerminals.delete(key);
  pendingTerminalFocus.delete(key);
}

export function startTerminalTab(workspaceId: string, tabName: string): void {
  if (tabName.startsWith("terminal:")) void startTerminal(workspaceId, tabName.slice("terminal:".length));
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
