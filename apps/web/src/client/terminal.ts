/// <reference lib="dom" />

import { init, Terminal, FitAddon } from "ghostty-web";

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

function tabId(title: string): string {
  return `terminal-${title.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
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
  const state = terminals.get(terminalKey(workspaceId, title));
  if (!state) return;
  state.ws.close();
  state.fit.dispose();
  state.term.dispose();
  terminals.delete(terminalKey(workspaceId, title));
}

function activateTab(root: HTMLElement, tabName: string): void {
  root.querySelectorAll<HTMLElement>(".tab[data-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
    tab.classList.toggle("muted", tab.dataset.tab !== tabName);
  });
  document.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]").forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.tabPane === tabName);
  });

  if (tabName.startsWith("terminal:")) {
    const workspaceId = root.dataset.workspaceId;
    const title = tabName.slice("terminal:".length);
    if (workspaceId) void startTerminal(workspaceId, title);
  }
}

function terminalTabHtml(title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "tab closable muted";
  button.type = "button";
  button.dataset.tab = `terminal:${title}`;
  button.dataset.terminalTitle = title;
  button.innerHTML = `▣ ${escapeHtml(title)} <span class="tab-close" data-close-terminal title="Close terminal">×</span>`;
  return button;
}

function terminalPaneHtml(title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "tab-pane";
  section.dataset.tabPane = `terminal:${title}`;
  section.innerHTML = `<div class="terminal-pane" data-terminal-title="${escapeHtml(title)}"><div class="terminal-bar">${escapeHtml(title)} · tmux</div><div class="ghostty-terminal" tabindex="0"></div></div>`;
  return section;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function createTerminal(root: HTMLElement): Promise<void> {
  const workspaceId = root.dataset.workspaceId;
  if (!workspaceId) return;
  const response = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/terminals`, { method: "POST", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(await response.text());
  const { title } = await response.json() as { title: string };

  const addButton = root.querySelector<HTMLElement>("#add-terminal");
  addButton?.before(terminalTabHtml(title));
  document.querySelector<HTMLElement>(".workspace-panes")?.append(terminalPaneHtml(title));
  activateTab(root, `terminal:${title}`);
}

async function deleteTerminal(root: HTMLElement, title: string): Promise<void> {
  const workspaceId = root.dataset.workspaceId;
  if (!workspaceId) return;
  const response = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/terminals/${encodeURIComponent(title)}/delete`, { method: "POST" });
  if (!response.ok && response.status !== 404) throw new Error(await response.text());

  stopTerminal(workspaceId, title);
  Array.from(root.querySelectorAll<HTMLElement>(".tab[data-terminal-title]")).find((tab) => tab.dataset.terminalTitle === title)?.remove();
  Array.from(document.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]")).find((pane) => pane.dataset.tabPane === `terminal:${title}`)?.remove();
  activateTab(root, "agent");
}

function bootWorkspaceTerminals(): void {
  const root = document.querySelector<HTMLElement>(".workspace-tabs[data-workspace-id]");
  if (!root || root.dataset.terminalBooted === "true") return;
  root.dataset.terminalBooted = "true";

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const close = target.closest<HTMLElement>("[data-close-terminal]");
    if (close) {
      event.stopPropagation();
      const tab = close.closest<HTMLElement>(".tab[data-terminal-title]");
      const title = tab?.dataset.terminalTitle;
      if (title) void deleteTerminal(root, title).catch((error) => alert(error instanceof Error ? error.message : String(error)));
      return;
    }

    const add = target.closest<HTMLElement>("#add-terminal");
    if (add) {
      void createTerminal(root).catch((error) => alert(error instanceof Error ? error.message : String(error)));
      return;
    }

    const tab = target.closest<HTMLElement>(".tab[data-tab]");
    if (tab?.dataset.tab) activateTab(root, tab.dataset.tab);
  });

  document.querySelectorAll<HTMLElement>(".tab-pane.active[data-tab-pane^='terminal:']").forEach((pane) => {
    const title = pane.dataset.tabPane?.slice("terminal:".length);
    const workspaceId = root.dataset.workspaceId;
    if (workspaceId && title) void startTerminal(workspaceId, title);
  });
}

document.addEventListener("DOMContentLoaded", bootWorkspaceTerminals);
document.addEventListener("turbo:load", bootWorkspaceTerminals);
