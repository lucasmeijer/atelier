import { createWorkspace, workspaceCommand } from "@atelier/core";
import { createWorkspaceTerminal } from "./workspace-terminals.ts";

export async function workspaceCommandWithTerminals(args: string[]): Promise<unknown> {
  if (args[0] === "new" && args.length === 1) {
    const created = await createWorkspace();
    await createWorkspaceTerminal(created.id);
    return created;
  }

  return await workspaceCommand(args);
}
