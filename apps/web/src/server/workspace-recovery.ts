import type { WorkspaceListResult } from "@atelier/workspace";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

/** Container failures belong to their workspace, not to application startup. */
export async function recoverWorkspaces(
  workspaces: WorkspaceListResult["workspaces"],
  registry: WorkspaceRegistry,
  setRunning: (id: string, running: boolean) => Promise<null | void>,
): Promise<void> {
  const recovered = await Promise.all(workspaces.map(async (workspace) => {
    try {
      await setRunning(workspace.id, !workspace.parked);
      return workspace;
    } catch (error) {
      console.error(`could not restore workspace ${workspace.id}`, error);
      return { ...workspace, recoveryError: `Could not restore workspace: ${error instanceof Error ? error.message : String(error)}` };
    }
  }));
  await registry.seed(recovered);
}
