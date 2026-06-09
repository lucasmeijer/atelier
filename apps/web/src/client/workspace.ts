/// <reference lib="dom" />

import { createAgentChatController, startAgentTab } from "@atelier/agent/client";
import { init, Terminal, FitAddon } from "ghostty-web";

declare global {
  interface Window {
    Stimulus: {
      Application: { start(): { register(identifier: string, controllerConstructor: unknown): void; getControllerForElementAndIdentifier(element: Element, identifier: string): unknown } };
      Controller: new (...args: unknown[]) => { element: Element };
    };
  }
}

const { Application, Controller } = window.Stimulus;

interface TerminalState {
  term: Terminal;
  ws: WebSocket;
  fit: FitAddon;
}

type TerminalTheme = Record<string, string>;
type TerminalThemeName = keyof typeof TERMINAL_THEMES;

const TERMINAL_THEME_COOKIE = "atelier_terminal_theme";
const DEFAULT_TERMINAL_THEME: TerminalThemeName = "tokyo-night";
const TERMINAL_THEMES = {
  "tokyo-night": {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  "catppuccin-mocha": {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
} as const satisfies Record<string, TerminalTheme>;

let ghosttyReady: Promise<void> | undefined;
const terminals = new Map<string, TerminalState>();

function terminalKey(workspaceId: string, title: string): string {
  return `${workspaceId}\u0000${title}`;
}

function readCookie(name: string): string | undefined {
  return document.cookie
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

function terminalThemeName(): TerminalThemeName {
  const value = decodeURIComponent(readCookie(TERMINAL_THEME_COOKIE) ?? "");
  return value in TERMINAL_THEMES ? value as TerminalThemeName : DEFAULT_TERMINAL_THEME;
}

function terminalTheme(): TerminalTheme {
  return TERMINAL_THEMES[terminalThemeName()];
}

function applyTerminalChromeTheme(theme: TerminalTheme): void {
  document.documentElement.style.setProperty("--terminal-bg", theme.background);
  document.documentElement.style.setProperty("--terminal-fg", theme.foreground);
  document.documentElement.style.setProperty("--terminal-cursor", theme.cursor);
  document.documentElement.style.setProperty("--terminal-bar-bg", theme.black);
  document.documentElement.style.setProperty("--terminal-bar-fg", theme.brightBlue ?? theme.foreground);
  document.documentElement.style.setProperty("--terminal-border", theme.brightBlack ?? theme.black);
}

function applyTerminalTheme(name: TerminalThemeName): void {
  const theme = TERMINAL_THEMES[name];
  writeCookie(TERMINAL_THEME_COOKIE, name);
  applyTerminalChromeTheme(theme);

  document.querySelectorAll<HTMLSelectElement>("[data-terminal-theme-select]").forEach((select) => {
    select.value = name;
  });

  reloadOpenTerminals();
}

function reloadOpenTerminals(): void {
  const openTerminals = Array.from(terminals.keys()).map((key) => {
    const [workspaceId, title] = key.split("\u0000");
    return { workspaceId, title };
  });

  for (const { workspaceId, title } of openTerminals) {
    stopTerminal(workspaceId, title);
    const pane = Array.from(document.querySelectorAll<HTMLElement>(".terminal-pane[data-terminal-title]")).find((candidate) => candidate.dataset.terminalTitle === title);
    pane?.querySelector<HTMLElement>(".ghostty-terminal")?.replaceChildren();
    void startTerminal(workspaceId, title);
  }
}

applyTerminalChromeTheme(terminalTheme());

async function startTerminal(workspaceId: string, title: string): Promise<void> {
  const key = terminalKey(workspaceId, title);
  const pane = Array.from(document.querySelectorAll<HTMLElement>(".terminal-pane[data-terminal-title]")).find((candidate) => candidate.dataset.terminalTitle === title);
  const host = pane?.querySelector<HTMLElement>(".ghostty-terminal");
  if (!host) return;

  const existing = terminals.get(key);
  if (existing) {
    existing.term.focus();
    existing.fit.fit();
    return;
  }

  ghosttyReady ??= init();
  await ghosttyReady;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    scrollback: 10000,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  fit.observeResize();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const tabId = `terminal:${title}`;
  const ws = new WebSocket(`${protocol}//${location.host}/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(tabId)}/ws?cols=${term.cols}&rows=${term.rows}`);

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

  terminals.set(key, { term, ws, fit });
  term.focus();
}

function stopTerminal(workspaceId: string, title: string): void {
  const key = terminalKey(workspaceId, title);
  const state = terminals.get(key);
  if (!state) return;
  state.ws.onclose = null;
  state.ws.onerror = null;
  state.ws.close();
  state.fit.dispose();
  state.term.dispose();
  terminals.delete(key);
}

class WorkspaceTabsController extends Controller {
  static values = { workspaceId: String };
  declare readonly element: HTMLElement;
  declare readonly workspaceIdValue: string;

  connect(): void {
    const activeTerminal = document.querySelector<HTMLElement>(".tab-pane.active[data-tab-pane^='terminal:']");
    const title = activeTerminal?.dataset.tabPane?.slice("terminal:".length);
    if (title) void startTerminal(this.workspaceIdValue, title);
  }

  activate(event: Event & { params?: { tab?: string } }): void {
    const tabName = event.params?.tab ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.tab : undefined);
    if (!tabName) return;
    this.activateTab(tabName);
  }

  stopPropagation(event: Event): void {
    event.stopPropagation();
  }

  activateTab(tabName: string): void {
    this.element.querySelectorAll<HTMLElement>(".tab[data-tab]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
      tab.classList.toggle("muted", tab.dataset.tab !== tabName);
    });
    document.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.tabPane === tabName);
    });

    if (tabName.startsWith("terminal:")) {
      void startTerminal(this.workspaceIdValue, tabName.slice("terminal:".length));
    }
    startAgentTab(application, tabName);
  }
}

class TerminalPaneController extends Controller {
  static values = { workspaceId: String, title: String, autostart: Boolean };
  declare readonly element: HTMLElement;
  declare readonly workspaceIdValue: string;
  declare readonly titleValue: string;
  declare readonly autostartValue: boolean;

  connect(): void {
    const pane = this.element.closest<HTMLElement>(".tab-pane[data-tab-pane]");
    if (this.autostartValue || pane?.classList.contains("active")) {
      void startTerminal(this.workspaceIdValue, this.titleValue);
    }
  }

  disconnect(): void {
    stopTerminal(this.workspaceIdValue, this.titleValue);
  }
}

class TerminalThemeController extends Controller {
  declare readonly element: HTMLSelectElement;

  connect(): void {
    this.element.value = terminalThemeName();
  }

  change(): void {
    const value = this.element.value;
    if (value in TERMINAL_THEMES) applyTerminalTheme(value as TerminalThemeName);
  }
}

class ActivateTabController extends Controller {
  static values = { tab: String };
  declare readonly element: HTMLElement;
  declare readonly tabValue: string;

  connect(): void {
    const tabs = document.querySelector<HTMLElement>('[data-controller~="workspace-tabs"]');
    const controller = tabs ? application.getControllerForElementAndIdentifier(tabs, "workspace-tabs") as WorkspaceTabsController | null : null;
    controller?.activateTab(this.tabValue);
    this.element.remove();
  }
}

class ModalController extends Controller {
  static values = { autoShow: Boolean };
  declare readonly element: HTMLDialogElement;
  declare readonly autoShowValue: boolean;

  connect(): void {
    if (this.autoShowValue && !this.element.open) this.element.showModal();
  }

  close(): void {
    this.element.close();
  }
}

class ModalOpenerController extends Controller {
  static values = { targetId: String };
  declare readonly element: HTMLElement;
  declare readonly targetIdValue: string;

  open(): void {
    const dialog = document.getElementById(this.targetIdValue) as HTMLDialogElement | null;
    if (dialog && !dialog.open) dialog.showModal();
  }
}

class RedirectController extends Controller {
  static values = { url: String };
  declare readonly element: HTMLElement;
  declare readonly urlValue: string;

  connect(): void {
    location.href = this.urlValue;
  }
}

class GlobalFilterController extends Controller {
  declare readonly element: HTMLInputElement;
  filter(): void {
    const q = this.element.value.toLowerCase();
    document.querySelectorAll<HTMLElement>(".table .row:not(.head)").forEach((row) => {
      row.style.display = row.textContent?.toLowerCase().includes(q) ? "" : "none";
    });
  }
}

const application = Application.start();
application.register("workspace-tabs", WorkspaceTabsController);
application.register("terminal-pane", TerminalPaneController);
application.register("terminal-theme", TerminalThemeController);
application.register("agent-chat", createAgentChatController(Controller));
application.register("activate-tab", ActivateTabController);
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("redirect", RedirectController);
application.register("global-filter", GlobalFilterController);
