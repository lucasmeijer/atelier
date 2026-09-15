import type { WorkspaceProvisionStepEvent } from "@atelier/workspace";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

interface WorkspaceReadinessOperations {
  checkReadiness(id: string): Promise<void>;
  waitForContinue(id: string, stepId: string): Promise<"retry" | void>;
  step?(event: WorkspaceProvisionStepEvent): Promise<void> | void;
}

/** Readiness failures retain the container and pause until retry or explicit bypass. */
export async function prepareWorkspaceForUse(id: string, registry: WorkspaceRegistry, operations: WorkspaceReadinessOperations): Promise<void> {
  const entry = registry.get(id);
  const step = { workspaceId: id, id: "workspace.startup", label: "Prepare workspace" };
  while (registry.get(id) === entry) {
    await operations.step?.({ ...step, status: "running" });
    try {
      await operations.checkReadiness(id);
      if (registry.get(id) !== entry) return;
      registry.setIssue(id, "readiness");
      await operations.step?.({ ...step, status: "done" });
      return;
    } catch (error) {
      if (registry.get(id) !== entry) return;
      const message = `${error instanceof Error ? error.message : String(error)} Required images or gateways may be unavailable.`;
      console.error(`workspace preparation failed ${id}`, error);
      registry.setIssue(id, "readiness", message);
      const continuation = operations.waitForContinue(id, step.id);
      await operations.step?.({ ...step, status: "failed", error: message, awaitingContinue: true, retryable: true });
      if (await continuation === "retry") continue;
      if (registry.get(id) !== entry) return;
      await operations.step?.({ ...step, status: "failed", detail: "Continuing despite preparation failure", awaitingContinue: false });
      return;
    }
  }
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
    if (entry.deletion) return [];
    const { id, parked } = entry;
    const current = () => registry.get(id) === entry && !entry.deletion && entry.parked === parked;
    if (!parked) registry.setPhase(id, "starting");
    const restore = async () => {
      const step = { workspaceId: id, id: "workspace.container", label: parked ? "Keep workspace parked" : "Start workspace container" };
      await operations.step?.({ ...step, status: "running" });
      try {
        await operations.setRunning(id, !parked);
      } catch (error) {
        console.error(`could not restore workspace ${id}`, error);
        if (current()) {
          const message = error instanceof Error ? error.message : String(error);
          await operations.step?.({ ...step, status: "failed", error: message });
          registry.setPhase(id, "failed", message);
        }
        return;
      }
      if (!current()) return;
      await operations.step?.({ ...step, status: "done" });
      if (parked) return;
      await prepareWorkspaceForUse(id, registry, operations);
      if (current()) registry.setPhase(id, "ready");
    };
    const inspectImage = async () => {
      try {
        const outdated = await operations.imageOutdated(id);
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
