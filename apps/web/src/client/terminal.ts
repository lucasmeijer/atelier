/// <reference lib="dom" />

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

let ghosttyReady: Promise<void> | undefined;
const terminals = new Map<string, TerminalState>();

function terminalKey(workspaceId: string, title: string): string {
  return `${workspaceId}\u0000${title}`;
}

function terminalTheme() {
  return {
    background: "#0f172a",
    foreground: "#dbeafe",
    cursor: "#bfdbfe",
    black: "#0f172a",
    red: "#f87171",
    green: "#34d399",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e5e7eb",
    brightBlack: "#64748b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#ffffff",
  };
}

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
  const ws = new WebSocket(`${protocol}//${location.host}/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(title)}/ws?cols=${term.cols}&rows=${term.rows}`);

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
application.register("activate-tab", ActivateTabController);
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("redirect", RedirectController);
application.register("global-filter", GlobalFilterController);
