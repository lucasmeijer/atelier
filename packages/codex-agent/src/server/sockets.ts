import { attachObservableTerminal, type ObservableTerminalConnection } from "@atelier/observable-terminal/server";
import { parseObservableTerminalMessage } from "@atelier/observable-terminal/shared";
import type { WorkspaceServerSocketHandler } from "@atelier/shared";
import { workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import { codexSession } from "./sessions.ts";

function dimension(value: string | null, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 1000 ? number : fallback;
}

export const codexSocketHandler: WorkspaceServerSocketHandler = async (url) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/codex-agents\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const session = codexSession(workspaceId, decodeURIComponent(match[2]!));
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
