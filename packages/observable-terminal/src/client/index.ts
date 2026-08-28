/// <reference lib="dom" />

import { createTerminal, type TerminalTheme } from "@gespenst/core";
import { encodeObservableTerminalMessage } from "../shared/index.ts";

declare const ATELIER_GHOSTTY_WASM_URL: string;
declare const ATELIER_GHOSTTY_CALLBACKS_WASM_URL: string;

export type ObservableTerminalTheme = TerminalTheme;

const DEFAULT_OBSERVABLE_TERMINAL_THEME = {
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

/** Map Atelier's active UI theme onto Gespenst's complete 16-color ANSI palette. */
export function atelierObservableTerminalTheme(): ObservableTerminalTheme {
  const background = themeColor("--bg", "background");
  const foreground = themeColor("--text", "foreground");
  const accent = themeColor("--accent", "brightBlue");
  const red = cssVariable("--danger") ?? foreground;
  const green = cssVariable("--success") ?? foreground;
  const amber = cssVariable("--warning") ?? foreground;
  const violet = cssVariable("--decorative") ?? accent;
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
    brightBlack: themeColor("--line-strong", "brightBlack"),
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
  sendInput(data: string): void;
  setTheme(theme: ObservableTerminalTheme): void;
}

export interface ObservableTerminalViewerOptions {
  host: HTMLElement;
  websocketUrl: string;
  mode: "interactive" | "fixed-readonly";
  cols?: number;
  rows?: number;
  fontSize?: number;
  fontFamily?: string;
  theme?: ObservableTerminalTheme;
  disconnectedMessage?: string;
  errorMessage?: string;
  transformInput?: (data: string) => string;
  onOutput?: (text: string) => void;
}

const terminalProgressState = {
  remove: 0,
  set: 1,
  error: 2,
  indeterminate: 3,
  pause: 4,
} as const;

export function observableWebSocketUrl(path: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}

export async function createObservableTerminalViewer(options: ObservableTerminalViewerOptions): Promise<ObservableTerminalViewer> {
  const theme = options.theme ?? DEFAULT_OBSERVABLE_TERMINAL_THEME;
  const fontSize = options.fontSize ?? (options.mode === "fixed-readonly" ? 11 : 13);
  const fontFamily = options.fontFamily ?? "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

  const term = await createTerminal({
    container: options.host,
    fontSizePx: fontSize,
    fontFamily,
    scrollbackLines: options.mode === "fixed-readonly" ? 4000 : 10000,
    theme,
    accessibility: "basic",
    worker: "dedicated",
    defaultCursorBlink: options.mode === "interactive",
    wasm: ATELIER_GHOSTTY_WASM_URL,
    callbacksWasm: ATELIER_GHOSTTY_CALLBACKS_WASM_URL,
    cols: options.cols,
    rows: options.rows,
  });
  const terminalInput = term.element.querySelector<HTMLTextAreaElement>(".gespenst__input");
  if (terminalInput && options.mode === "fixed-readonly") terminalInput.readOnly = true;

  const ws = new WebSocket(options.websocketUrl);
  ws.binaryType = "arraybuffer";
  const sendInput = (data: string): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  const outputDecoder = new TextDecoder();
  const inputDecoder = new TextDecoder();
  term.on("error", (error) => console.error("Gespenst terminal error", error));

  if (options.mode === "interactive") {
    term.on("progress", ({ state, progress }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeObservableTerminalMessage({ type: "progress", state: terminalProgressState[state], value: progress ?? undefined }));
      }
    });
    term.on("resize", ({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeObservableTerminalMessage({ type: "resize", cols, rows }));
    });
    term.on("input", ({ data }) => {
      const text = inputDecoder.decode(data, { stream: true });
      sendInput(options.transformInput?.(text) ?? text);
    });
  }

  ws.onopen = () => {
    if (options.mode === "interactive") {
      const { cols, rows } = term.geometry;
      ws.send(encodeObservableTerminalMessage({ type: "resize", cols, rows }));
    }
  };
  ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    if (event.data instanceof ArrayBuffer) {
      const data = new Uint8Array(event.data);
      if (options.onOutput) options.onOutput(outputDecoder.decode(data, { stream: true }));
      term.write(data);
      return;
    }
    options.onOutput?.(event.data);
    term.write(event.data);
  };
  ws.onclose = () => {
    const message = options.disconnectedMessage;
    if (message) term.write(message);
  };
  ws.onerror = () => {
    const message = options.errorMessage;
    if (message) term.write(message);
  };

  return {
    focus: () => term.focus(),
    fitToHost: () => term.fit(),
    sendInput,
    setTheme: (nextTheme) => void term.setTheme(nextTheme),
    dispose: () => {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      term.dispose();
    },
  };
}
