import type { AtelierEventBus } from "@atelier/core";
import { createWorkspaceTerminal } from "./workspace-terminals.ts";

export function registerTerminalEvents(events: AtelierEventBus): void {
  events.on("workspace_created", async ({ workspaceId }) => {
    await createWorkspaceTerminal(workspaceId);
  });
}
