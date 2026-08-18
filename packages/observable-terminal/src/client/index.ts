/// <reference lib="dom" />

import { FitAddon } from "@xterm/addon-fit";
import { ProgressAddon } from "@xterm/addon-progress";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { encodeObservableTerminalMessage } from "../shared/index.ts";

export interface ObservableTerminalTheme {
  [color: string]: string;
}

export const DEFAULT_OBSERVABLE_TERMINAL_THEME = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  black: "#3b4252",
  brightBlack: "#4c566a",
  brightBlue: "#81a1c1",
} as const satisfies ObservableTerminalTheme;

function cssVariable(name: string): string | undefined {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

function themeColor(name: string, fallbackKey: keyof typeof DEFAULT_OBSERVABLE_TERMINAL_THEME): string {
  return cssVariable(name) ?? DEFAULT_OBSERVABLE_TERMINAL_THEME[fallbackKey];
}

/** Map Atelier's active UI theme onto xterm's complete 16-color ANSI palette. */
export function atelierObservableTerminalTheme(): ObservableTerminalTheme {
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

export interface ObservableTerminalViewer {
  dispose(): void;
  focus(): void;
  fitToHost(): void;
  setTheme(theme: ObservableTerminalTheme): void;
}

export interface ObservableTerminalViewerOptions {
  host: HTMLElement;
  websocketUrl: string;
  mode: "interactive" | "fixed-readonly";
  cols?: number;
  rows?: number;
  focus?: boolean;
  fontSize?: number;
  fontFamily?: string;
  scrollback?: number;
  theme?: ObservableTerminalTheme;
  loadFont?: boolean;
  disconnectedMessage?: string;
  errorMessage?: string;
  onProgress?: (progress: { state: number; value?: number }) => void;
  onOutput?: (data: string | Uint8Array) => void;
  onClose?: () => void;
}

export function applyObservableTerminalChromeTheme(theme: ObservableTerminalTheme = DEFAULT_OBSERVABLE_TERMINAL_THEME): void {
  document.documentElement.style.setProperty("--terminal-bg", theme.background);
  document.documentElement.style.setProperty("--terminal-fg", theme.foreground);
  document.documentElement.style.setProperty("--terminal-cursor", theme.cursor);
  document.documentElement.style.setProperty("--terminal-bar-bg", theme.black);
  document.documentElement.style.setProperty("--terminal-bar-fg", theme.brightBlue ?? theme.foreground);
  document.documentElement.style.setProperty("--terminal-border", theme.brightBlack ?? theme.black);
}

export function observableWebSocketUrl(path: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}

export async function createObservableTerminalViewer(options: ObservableTerminalViewerOptions): Promise<ObservableTerminalViewer> {
  const theme = options.theme ?? DEFAULT_OBSERVABLE_TERMINAL_THEME;
  const fontSize = options.fontSize ?? (options.mode === "fixed-readonly" ? 11 : 13);
  const fontFamily = options.fontFamily ?? "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  if (options.loadFont !== false) await document.fonts.load(`${fontSize}px "JetBrains Mono"`);

  const terminalOptions: ConstructorParameters<typeof Terminal>[0] = {
    allowProposedApi: options.mode === "interactive",
    cursorBlink: options.mode === "interactive",
    disableStdin: options.mode === "fixed-readonly",
    fontSize,
    fontFamily,
    logLevel: "error",
    scrollback: options.scrollback ?? (options.mode === "fixed-readonly" ? 4000 : 10000),
    theme,
  };
  if (options.cols !== undefined) terminalOptions.cols = options.cols;
  if (options.rows !== undefined) terminalOptions.rows = options.rows;

  const term = new Terminal(terminalOptions);
  if (options.mode === "fixed-readonly") term.attachCustomKeyEventHandler(() => false);

  let fit: FitAddon | undefined;
  let progress: ProgressAddon | undefined;
  let progressSubscription: { dispose(): void } | undefined;
  let resizeObserver: ResizeObserver | undefined;

  if (options.mode === "interactive") {
    fit = new FitAddon();
    progress = new ProgressAddon();
    const unicode11 = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(progress);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
  }

  term.open(options.host);
  fit?.fit();

  if (options.mode === "interactive" && fit) {
    resizeObserver = new ResizeObserver(() => fit?.fit());
    resizeObserver.observe(options.host);
  }

  const ws = new WebSocket(options.websocketUrl);
  ws.binaryType = "arraybuffer";

  if (options.mode === "interactive") {
    if (progress) {
      progressSubscription = progress.onChange(({ state, value }) => {
        const event = { state, value };
        options.onProgress?.(event);
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeObservableTerminalMessage({ type: "progress", ...event }));
      });
    }
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeObservableTerminalMessage({ type: "resize", cols, rows }));
    });
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
  }

  ws.onopen = () => {
    if (options.mode === "interactive") ws.send(encodeObservableTerminalMessage({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
    options.onOutput?.(data);
    term.write(data);
  };
  ws.onclose = () => {
    options.onClose?.();
    const message = options.disconnectedMessage;
    if (message) term.write(message);
  };
  ws.onerror = () => {
    const message = options.errorMessage;
    if (message) term.write(message);
  };

  const viewer: ObservableTerminalViewer = {
    focus: () => term.focus(),
    fitToHost: () => fit?.fit(),
    setTheme: (nextTheme) => {
      term.options.theme = nextTheme;
    },
    dispose: () => {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      progressSubscription?.dispose();
      resizeObserver?.disconnect();
      fit?.dispose();
      term.dispose();
    },
  };
  if (options.focus) term.focus();
  return viewer;
}
