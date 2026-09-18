import { AtelierCoreError } from "@atelier/core";
import { createObservableTerminalSocket, terminalSocketDimensions, buildNaturalScrollCommand } from "@atelier/observable-terminal/server";
import type { WorkspaceServerSocketHandler } from "@atelier/shared";
import { execWorkspaceShell, workspaceContainerName, workspaceRoot } from "@atelier/workspace";
import { terminalIdFromViewKey, terminalViewKey } from "../shared.ts";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

export function createTerminalSocketHandler(options: { setViewBusy(workspaceId: string, viewKey: string, busy: boolean): void }): WorkspaceServerSocketHandler {
  const busyTerminals = new Set<string>();

  function setBusy(workspaceId: string, terminalId: string, busy: boolean): void {
    const key = `${workspaceId}\0${terminalId}`;
    if (busyTerminals.has(key) === busy) return;
    if (busy) busyTerminals.add(key);
    else busyTerminals.delete(key);
    options.setViewBusy(workspaceId, terminalViewKey(terminalId), busy);
  }

  return async (url) => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/views\/([^/]+)\/ws$/);
    if (!match) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const terminalId = terminalIdFromViewKey(decodeURIComponent(match[2]!));
    if (!terminalId) return undefined;
    const terminal = (await listWorkspaceTerminals(workspaceId)).find((item) => item.id === terminalId);
    if (!terminal) throw new AtelierCoreError("terminal_not_found", `terminal not found: ${terminalId}`);
    const configured = await execWorkspaceShell(workspaceId, buildNaturalScrollCommand());
    if (configured.exitCode !== 0) throw new AtelierCoreError("terminal_scrollback_failed", configured.stderr.trim() || "could not configure terminal scrollback");
    return createObservableTerminalSocket({
      containerName: workspaceContainerName(workspaceId),
      session: terminal.tmuxSession,
      ...terminalSocketDimensions(url),
      user: "atelier",
      workdir: workspaceRoot,
    }, {
      onProgress: (progress) => setBusy(workspaceId, terminalId, progress.state !== 0),
      onClose: () => setBusy(workspaceId, terminalId, false),
    });
  };
}
