import { AtelierCoreError } from "@atelier/core";
import { attachObservableTerminal, type IPty } from "@atelier/observable-terminal/server";
import { parseObservableTerminalMessage } from "@atelier/observable-terminal/shared";
import type { WorkspaceServerSocketHandler } from "@atelier/shared";
import { workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import type { ServerWebSocket } from "bun";
import { terminalIdFromTabKey, terminalTabKey } from "../shared.ts";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

interface TerminalSocketData {
  kind: "terminal";
  workspaceId: string;
  terminalId: string;
  tmuxSession: string;
  cols: number;
  rows: number;
  pty?: IPty;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
}

export function createTerminalSocketHandler(options: { setTabBusy(workspaceId: string, tabKey: string, busy: boolean): void }): WorkspaceServerSocketHandler {
  const busyTerminals = new Set<string>();

  function setBusy(workspaceId: string, terminalId: string, busy: boolean): void {
    const key = `${workspaceId}\0${terminalId}`;
    if (busyTerminals.has(key) === busy) return;
    if (busy) busyTerminals.add(key);
    else busyTerminals.delete(key);
    options.setTabBusy(workspaceId, terminalTabKey(terminalId), busy);
  }

  async function validate(url: URL): Promise<TerminalSocketData | undefined> {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/ws$/);
    if (!match) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const terminalId = terminalIdFromTabKey(decodeURIComponent(match[2]!));
    if (!terminalId) return undefined;
    const terminal = (await listWorkspaceTerminals(workspaceId)).find((item) => item.id === terminalId);
    if (!terminal) throw new AtelierCoreError("terminal_not_found", `terminal not found: ${terminalId}`);
    return {
      kind: "terminal",
      workspaceId,
      terminalId,
      tmuxSession: terminal.tmuxSession,
      cols: parsePositiveInteger(url.searchParams.get("cols"), 80),
      rows: parsePositiveInteger(url.searchParams.get("rows"), 24),
    };
  }

  function open(ws: ServerWebSocket<TerminalSocketData>): void {
    const data = ws.data;
    try {
      const pty = attachObservableTerminal({
        containerName: workspaceContainerName(data.workspaceId),
        session: data.tmuxSession,
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

  function message(ws: ServerWebSocket<TerminalSocketData>, input: string | Buffer): void {
    const text = typeof input === "string" ? input : input.toString();
    const control = parseObservableTerminalMessage(text);
    if (control?.type === "resize") {
      ws.data.pty?.resize(control.cols, control.rows);
      return;
    }
    if (control?.type === "progress") {
      setBusy(ws.data.workspaceId, ws.data.terminalId, control.state !== 0);
      return;
    }
    ws.data.pty?.write(text);
  }

  function close(ws: ServerWebSocket<TerminalSocketData>): void {
    setBusy(ws.data.workspaceId, ws.data.terminalId, false);
    ws.data.pty?.kill();
  }

  return {
    validate: (_request, url) => validate(url),
    open: (socket) => open(socket as ServerWebSocket<TerminalSocketData>),
    message: (socket, input) => message(socket as ServerWebSocket<TerminalSocketData>, input as string | Buffer),
    close: (socket) => close(socket as ServerWebSocket<TerminalSocketData>),
  };
}
