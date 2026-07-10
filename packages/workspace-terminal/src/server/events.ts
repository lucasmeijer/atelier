import type { AtelierEventBus } from "@atelier/core";
import { listWorkspaceTerminals } from "./workspace-terminals.ts";

function terminalSignature(terminals: Array<{ title: string }>): string {
  return terminals.map((terminal) => terminal.title).sort().join("\n");
}

const signatures = new Map<string, string>();

export function rememberWorkspaceTerminalSignature(workspaceId: string, terminals: Array<{ title: string }>): void {
  signatures.set(workspaceId, terminalSignature(terminals));
}

export function forgetWorkspaceTerminalSignature(workspaceId: string): void {
  signatures.delete(workspaceId);
}

async function rememberSignature(workspaceId: string): Promise<void> {
  rememberWorkspaceTerminalSignature(workspaceId, (await listWorkspaceTerminals(workspaceId)).terminals);
}

export function registerTerminalEvents(events: AtelierEventBus): void {
  events.on("workspace_created", async ({ workspaceId }) => {
    await rememberSignature(workspaceId);
  });

  events.on("workspace_agent_turn_finished", async ({ workspaceId }) => {
    const signature = terminalSignature((await listWorkspaceTerminals(workspaceId)).terminals);
    const previous = signatures.get(workspaceId);
    signatures.set(workspaceId, signature);
    if (previous === undefined || signature === previous) return;
    await events.emit("workspace_tabs_changed", { workspaceId });
  });
}
