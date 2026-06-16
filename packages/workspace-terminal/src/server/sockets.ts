import type { IPty } from "@atelier/observable-terminal/server";
import type { ServerWebSocket } from "bun";
import { AtelierCoreError } from "@atelier/core";
import { workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import { attachObservableTerminal } from "@atelier/observable-terminal/server";
import { observableTerminalTabPrefix, parseObservableTerminalMessage } from "@atelier/observable-terminal/shared";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

export interface TerminalSocketData {
  kind: "terminal";
  workspaceId: string;
  title: string;
  cols: number;
  rows: number;
  pty?: IPty;
}

export type TerminalTabBusyListener = (event: { workspaceId: string; tabKey: string; busy: boolean }) => void;

const terminalTabBusyListeners = new Set<TerminalTabBusyListener>();
const terminalTabBusy = new Map<string, boolean>();

export function subscribeTerminalTabBusy(listener: TerminalTabBusyListener): () => void {
  terminalTabBusyListeners.add(listener);
  return () => terminalTabBusyListeners.delete(listener);
}

function terminalTabKey(title: string): string {
  return `${observableTerminalTabPrefix}${title}`;
}

function terminalBusyKey(workspaceId: string, title: string): string {
  return `${workspaceId}\u0000${title}`;
}

function setTerminalTabBusy(workspaceId: string, title: string, busy: boolean): void {
  const key = terminalBusyKey(workspaceId, title);
  if ((terminalTabBusy.get(key) ?? false) === busy) return;
  if (busy) terminalTabBusy.set(key, true);
  else terminalTabBusy.delete(key);
  for (const listener of terminalTabBusyListeners) listener({ workspaceId, tabKey: terminalTabKey(title), busy });
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
}

export async function validateTerminalSocket(url: URL): Promise<TerminalSocketData | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]);
  const tabId = decodeURIComponent(match[2]);
  if (!tabId.startsWith(observableTerminalTabPrefix)) return undefined;
  const title = tabId.slice(observableTerminalTabPrefix.length);
  const { terminals } = await listWorkspaceTerminals(workspaceId);
  if (!terminals.some((terminal) => terminal.title === title)) throw new AtelierCoreError("terminal_not_found", `terminal not found: ${title}`);
  return {
    kind: "terminal",
    workspaceId,
    title,
    cols: parsePositiveInteger(url.searchParams.get("cols"), 80),
    rows: parsePositiveInteger(url.searchParams.get("rows"), 24),
  };
}

export function openTerminalSocket(ws: ServerWebSocket<TerminalSocketData>): void {
  const data = ws.data;
  try {
    const pty = attachObservableTerminal({
      containerName: workspaceContainerName(data.workspaceId),
      session: data.title,
      cols: data.cols,
      rows: data.rows,
      user: "atelier",
      workdir: workspaceRoot,
      readonly: false,
    });
    data.pty = pty;
    pty.onData((chunk) => {
      setTimeout(() => {
        try {
          ws.send(chunk);
        } catch {
          // Socket closed between PTY output and scheduled send.
        }
      }, 0);
    });
    pty.onExit(() => ws.close());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ws.send(`\r\n\x1b[31m[terminal failed to start: ${message}]\x1b[0m\r\n`);
    ws.close();
  }
}

export function handleTerminalSocketMessage(ws: ServerWebSocket<TerminalSocketData>, message: string | Buffer): void {
  const text = typeof message === "string" ? message : message.toString();
  const control = parseObservableTerminalMessage(text);
  if (control?.type === "resize") {
    ws.data.pty?.resize(control.cols, control.rows);
    return;
  }
  if (control?.type === "progress") {
    setTerminalTabBusy(ws.data.workspaceId, ws.data.title, control.state !== 0);
    return;
  }
  ws.data.pty?.write(text);
}

export function closeTerminalSocket(ws: ServerWebSocket<TerminalSocketData>): void {
  setTerminalTabBusy(ws.data.workspaceId, ws.data.title, false);
  ws.data.pty?.kill();
}
