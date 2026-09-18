import { AtelierCoreError } from "@atelier/core";
import { attachObservableTerminal, type ObservableTerminalConnection } from "@atelier/observable-terminal/server";
import { parseObservableTerminalMessage } from "@atelier/observable-terminal/shared";
import type { WorkspaceServerSocketHandler } from "@atelier/shared";
import { workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import type { CliSessions } from "./sessions.ts";

function dimension(value: string | null, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 1000 ? number : fallback;
}

export function cliSocketHandler(providerId: string, sessions: CliSessions): WorkspaceServerSocketHandler {
  return async (url) => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)\/([^/]+)\/ws$/);
    if (!match || match[2] !== `${providerId}-agents`) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const session = await sessions.ready(workspaceId, decodeURIComponent(match[3]!));
    if (session.error) throw new AtelierCoreError("agent_session_failed", session.error);
    let terminal: ObservableTerminalConnection;
    return {
      open(socket) {
        terminal = attachObservableTerminal({
          containerName: workspaceContainerName(workspaceId), session: session.tmuxSession,
          cols: dimension(url.searchParams.get("cols"), 80), rows: dimension(url.searchParams.get("rows"), 24),
          user: "atelier", workdir: workspaceRoot, readonly: false,
        }, { onData: (chunk) => socket.send(chunk), onExit: () => socket.close() });
      },
      message(_socket, input) {
        const text = input instanceof Uint8Array ? new TextDecoder().decode(input) : input;
        const control = parseObservableTerminalMessage(text);
        if (control?.type === "resize") terminal.resize(control.cols, control.rows);
        else if (!control) terminal.write(text);
      },
      close() { terminal.close(); },
    };
  };
}
