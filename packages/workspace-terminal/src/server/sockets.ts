import { AtelierCoreError } from "@atelier/core";
import { attachObservableTerminal, type IPty } from "@atelier/observable-terminal/server";
import { parseObservableTerminalMessage } from "@atelier/observable-terminal/shared";
import type { WorkspaceServerSocketHandler, WorkspaceSocketConnection } from "@atelier/shared";
import { workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import { terminalIdFromTabKey, terminalTabKey } from "../shared.ts";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

interface TerminalSocketData {
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
  const messageDecoder = new TextDecoder();

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
      workspaceId,
      terminalId,
      tmuxSession: terminal.tmuxSession,
      cols: parsePositiveInteger(url.searchParams.get("cols"), 80),
      rows: parsePositiveInteger(url.searchParams.get("rows"), 24),
    };
  }

  function open(socket: WorkspaceSocketConnection, data: TerminalSocketData): void {
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
            socket.send(chunk);
          } catch {
            // Socket closed between PTY output and scheduled send.
          }
        }, 0);
      });
      pty.onExit(() => socket.close());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.send(`\r\n\x1b[31m[terminal failed to start: ${message}]\x1b[0m\r\n`);
      socket.close();
    }
  }

  function message(data: TerminalSocketData, input: string | Uint8Array): void {
    const text = input instanceof Uint8Array ? messageDecoder.decode(input) : input;
    const control = parseObservableTerminalMessage(text);
    if (control?.type === "resize") {
      data.pty?.resize(control.cols, control.rows);
      return;
    }
    if (control?.type === "progress") {
      setBusy(data.workspaceId, data.terminalId, control.state !== 0);
      return;
    }
    data.pty?.write(text);
  }

  function close(data: TerminalSocketData): void {
    setBusy(data.workspaceId, data.terminalId, false);
    data.pty?.kill();
  }

  return async (url) => {
    const data = await validate(url);
    if (!data) return undefined;
    return {
      open: (socket) => open(socket, data),
      message: (_socket, input) => message(data, input),
      close: () => close(data),
    };
  };
}
