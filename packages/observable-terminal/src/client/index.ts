/// <reference lib="dom" />

import { FitAddon } from "@xterm/addon-fit";
import { ProgressAddon } from "@xterm/addon-progress";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { encodeObservableTerminalMessage } from "../shared/index.ts";

export type ObservableTerminalTheme = Record<string, string>;

export const DEFAULT_OBSERVABLE_TERMINAL_THEME = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  black: "#3b4252",
  brightBlack: "#4c566a",
  brightBlue: "#81a1c1",
} as const satisfies ObservableTerminalTheme;

export interface ObservableTerminalViewer {
  dispose(): void;
  focus(): void;
  fitToHost(): void;
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

  const term = new Terminal({
    allowProposedApi: options.mode === "interactive",
    cols: options.cols,
    rows: options.rows,
    cursorBlink: options.mode === "interactive",
    disableStdin: options.mode === "fixed-readonly",
    fontSize,
    fontFamily,
    logLevel: "error",
    scrollback: options.scrollback ?? (options.mode === "fixed-readonly" ? 4000 : 10000),
    theme,
  });

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

  if (options.mode === "interactive") {
    if (progress) {
      progressSubscription = progress.onChange(({ state, value }) => {
        const event = { state, value };
        options.onProgress?.(event);
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeObservableTerminalMessage({ type: "progress", ...event }));
      });
    }
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
    term.onResize((size) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeObservableTerminalMessage({ type: "resize", cols: size.cols, rows: size.rows }));
    });
  }

  ws.onopen = () => {
    if (options.mode === "interactive") ws.send(encodeObservableTerminalMessage({ type: "resize", cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (event) => {
    if (typeof event.data === "string") term.write(event.data);
    else event.data.arrayBuffer().then((buffer: ArrayBuffer) => term.write(new Uint8Array(buffer)));
  };
  ws.onclose = () => {
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
