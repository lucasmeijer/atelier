import { withCommandSignal } from "@atelier/core";
import type { WorkspaceProvisioning, WorkspaceProvisionRun } from "@atelier/workspace";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

interface WorkspaceReadinessOperations {
  checkReadiness(id: string, report: (detail: string) => void): Promise<void>;
  provisioning: WorkspaceProvisioning;
}

async function prepare(id: string, registry: WorkspaceRegistry, operations: WorkspaceReadinessOperations, run: WorkspaceProvisionRun): Promise<void> {
  const entry = registry.get(id);
  const current = () => registry.get(id) === entry && !entry?.phase.deletion;
  await run.step("workspace.startup", "Prepare workspace", async () => {
    if (!current()) return;
    try {
      await operations.checkReadiness(id, (detail) => run.report({ detail }));
      if (current()) registry.setIssue(id, "readiness");
    } catch (error) {
      if (!current()) return;
      const message = `${error instanceof Error ? error.message : String(error)} Required images or gateways may be unavailable.`;
      console.error(`workspace preparation failed ${id}`, error);
      registry.setIssue(id, "readiness", message);
      throw error;
    }
  }, "retry-or-continue");
}

/** Readiness failures retain the container and pause until retry or explicit bypass. */
export function prepareWorkspaceForUse(id: string, registry: WorkspaceRegistry, operations: WorkspaceReadinessOperations): Promise<void> {
  return operations.provisioning.run(id, (run) => prepare(id, registry, operations, run));
}

interface RecoveryOperations extends WorkspaceReadinessOperations {
  setRunning(id: string, running: boolean): Promise<null | void>;
  imageOutdated(id: string): Promise<boolean>;
}

/** Run after HTTP startup. Each workspace completes its own startup independently. */
export async function recoverWorkspaces(
  registry: WorkspaceRegistry,
  operations: RecoveryOperations,
): Promise<void> {
  await Promise.all(registry.list().flatMap((entry) => {
    if (entry.phase.deletion) return [];
    const { id, parked } = entry;
    const current = () => registry.get(id) === entry && !entry.phase.deletion && entry.parked === parked;
    if (!parked) registry.startProvisioning(id);
    const restore = async () => {
      try {
        await operations.provisioning.run(id, async (run) => {
          await run.step("workspace.container", parked ? "Keep workspace parked" : "Start workspace container", () => operations.setRunning(id, !parked));
          if (!current() || parked) return;
          await prepare(id, registry, operations, run);
        });
        if (current() && !parked) registry.startRunning(id);
      } catch (error) {
        if (!current()) return;
        console.error(`could not restore workspace ${id}`, error);
        registry.setProvisioningState(id, "failed", error instanceof Error ? error.message : String(error));
      }
    };
    const inspectImage = async () => {
      try {
        const outdated = await withCommandSignal(AbortSignal.timeout(60_000), () => operations.imageOutdated(id));
        if (current()) {
          registry.setImageOutdated(id, outdated);
          registry.setIssue(id, "image");
        }
      } catch (error) {
        console.error(`could not inspect workspace image ${id}`, error);
        if (current()) registry.setIssue(id, "image", "Could not check whether this workspace image is up to date.");
      }
    };
    return [restore(), inspectImage()];
  }));
}
