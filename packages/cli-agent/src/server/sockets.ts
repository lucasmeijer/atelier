import { AtelierCoreError } from "@atelier/core";
import { createObservableTerminalSocket, terminalSocketDimensions } from "@atelier/observable-terminal/server";
import type { WorkspaceServerSocketHandler } from "@atelier/shared";
import { workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import type { CliSessions } from "./sessions.ts";

export function cliSocketHandler(providerId: string, sessions: CliSessions): WorkspaceServerSocketHandler {
  return async (url) => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)\/([^/]+)\/ws$/);
    if (!match || match[2] !== `${providerId}-agents`) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const session = await sessions.ready(workspaceId, decodeURIComponent(match[3]!));
    if (session.error) throw new AtelierCoreError("agent_session_failed", session.error);
    return createObservableTerminalSocket({
      containerName: workspaceContainerName(workspaceId), session: session.tmuxSession,
      ...terminalSocketDimensions(url),
      user: "atelier", workdir: workspaceRoot, readonly: false,
    });
  };
}
