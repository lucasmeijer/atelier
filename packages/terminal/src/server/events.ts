import type { AtelierEventBus } from "@atelier/core";
import { createWorkspaceTerminal, listWorkspaceTerminals } from "./workspace-terminals.ts";

function terminalSignature(terminals: Array<{ title: string }>): string {
  return terminals.map((terminal) => terminal.title).sort().join("\n");
}

export function registerTerminalEvents(events: AtelierEventBus): void {
  const signatures = new Map<string, string>();

  async function rememberSignature(workspaceId: string): Promise<void> {
    signatures.set(workspaceId, terminalSignature((await listWorkspaceTerminals(workspaceId)).terminals));
  }

  events.on("workspace_created", async ({ workspaceId }) => {
    await createWorkspaceTerminal(workspaceId);
    await rememberSignature(workspaceId);
  });

  events.on("workspace_agent_turn_finished", async ({ workspaceId }) => {
    const signature = terminalSignature((await listWorkspaceTerminals(workspaceId)).terminals);
    if (signature === signatures.get(workspaceId)) return;
    signatures.set(workspaceId, signature);
    await events.emit("workspace_tabs_changed", { workspaceId });
  });
}
