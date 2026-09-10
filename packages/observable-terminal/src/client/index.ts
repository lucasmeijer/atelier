/// <reference lib="dom" />

import { createTerminal, KeyModifiers, type TerminalTheme } from "@gespenst/core";
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
  refresh(): void;
  sendInput(data: string): void;
  getSelection(): Promise<string>;
  dragPointer(event: PointerEvent, action: "press" | "motion" | "release", select: boolean): void;
  paste(text: string): void;
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
  if (options.mode === "fixed-readonly" && options.cols !== undefined && options.rows !== undefined) {
    const devicePixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
    options.host.style.width = `${term.geometry.widthPx / devicePixelRatio}px`;
    options.host.style.height = `${term.geometry.heightPx / devicePixelRatio}px`;
  }

  const websocketUrl = new URL(options.websocketUrl);
  if (options.mode === "interactive") {
    const { cols, rows } = term.geometry;
    websocketUrl.searchParams.set("cols", String(cols));
    websocketUrl.searchParams.set("rows", String(rows));
  }
  const ws = new WebSocket(websocketUrl);
  ws.binaryType = "arraybuffer";
  const sendInput = (data: string): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  const sendSize = ({ cols, rows }: { cols: number; rows: number }): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeObservableTerminalMessage({ type: "resize", cols, rows }));
  };
  let awaitingFirstOutput = true;
  let disposed = false;
  const writeOutput = (data: string | Uint8Array): void => {
    if (!awaitingFirstOutput) {
      term.write(data);
      return;
    }
    awaitingFirstOutput = false;
    // Keep the pane background visible until the first output has been rendered.
    void term.writeAsync(data).then(() => {
      if (!disposed) term.element.classList.add("observable-terminal-painted");
    }).catch((error: Error) => {
      if (!disposed) console.error("Could not paint initial terminal output", error);
    });
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
    term.on("resize", sendSize);
    term.on("input", ({ data }) => {
      const text = inputDecoder.decode(data, { stream: true });
      sendInput(options.transformInput?.(text) ?? text);
    });
  }

  ws.onopen = () => {
    if (options.mode === "interactive") sendSize(term.geometry);
  };
  ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
    options.onOutput?.(data instanceof Uint8Array ? outputDecoder.decode(data, { stream: true }) : data);
    writeOutput(data);
  };
  ws.onclose = () => {
    const message = options.disconnectedMessage;
    if (message) writeOutput(message);
  };
  ws.onerror = () => {
    const message = options.errorMessage;
    if (message) writeOutput(message);
  };

  return {
    focus: () => term.focus(),
    refresh: () => {
      term.fit();
      if (options.mode === "interactive") sendSize(term.geometry);
      // Gespenst has no explicit repaint operation. Reapplying the active theme
      // invalidates every row and repaints from its authoritative buffer.
      void term.setTheme(term.theme);
    },
    sendInput,
    getSelection: () => term.getSelection(),
    dragPointer: (event, action, select) => {
      const bounds = term.element.getBoundingClientRect();
      const scale = Math.max(1, globalThis.devicePixelRatio || 1);
      term.sendPointer({
        action,
        button: "left",
        x: (event.clientX - bounds.left) * scale,
        y: (event.clientY - bounds.top) * scale,
        anyButtonPressed: action !== "release",
        forceSelection: select,
        rectangle: event.altKey,
        // Shift chooses application mouse input, not an application modifier.
        modifiers: (event.ctrlKey ? KeyModifiers.control : 0)
          | (event.altKey ? KeyModifiers.alt : 0)
          | (event.metaKey ? KeyModifiers.meta : 0),
        timeMs: event.timeStamp,
      });
    },
    paste: (text) => term.paste(text),
    setTheme: (nextTheme) => void term.setTheme(nextTheme),
    dispose: () => {
      disposed = true;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      term.dispose();
    },
  };
}
