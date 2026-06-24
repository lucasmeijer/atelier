import type { AtelierEventBus } from "@atelier/core";
import { createWorkspaceTerminal, listWorkspaceTerminals } from "./workspace-terminals.ts";

function terminalSignature(terminals: Array<{ title: string }>): string {
  return terminals.map((terminal) => terminal.title).sort().join("\n");
}

const signatures = new Map<string, string>();

export function rememberWorkspaceTerminalSignature(workspaceId: string, terminals: Array<{ title: string }>): void {
  signatures.set(workspaceId, terminalSignature(terminals));
}

async function rememberSignature(workspaceId: string): Promise<void> {
  rememberWorkspaceTerminalSignature(workspaceId, (await listWorkspaceTerminals(workspaceId)).terminals);
}

export function registerTerminalEvents(events: AtelierEventBus): void {

  events.on("workspace_created", async ({ workspaceId }) => {
    await events.emit("workspace_provision_step", { workspaceId, id: "terminal.default", label: "Start default terminal", parentId: "workspace.integrations", status: "running" });
    await createWorkspaceTerminal(workspaceId);
    await rememberSignature(workspaceId);
    await events.emit("workspace_provision_step", { workspaceId, id: "terminal.default", label: "Start default terminal", parentId: "workspace.integrations", status: "done" });
  });

  events.on("workspace_agent_turn_finished", async ({ workspaceId }) => {
    const signature = terminalSignature((await listWorkspaceTerminals(workspaceId)).terminals);
    const previous = signatures.get(workspaceId);
    signatures.set(workspaceId, signature);
    if (previous === undefined || signature === previous) return;
    await events.emit("workspace_tabs_changed", { workspaceId });
  });
}
