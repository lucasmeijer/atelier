import type { WorkspaceProvisionStepEvent } from "@atelier/workspace";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

interface GatewayStartupOperations {
  checkGateway(id: string): Promise<void>;
  waitForContinue(id: string, stepId: string): Promise<void>;
  step?(event: WorkspaceProvisionStepEvent): Promise<void> | void;
}

/** Gateway failure pauses startup until the user explicitly chooses to continue. */
export async function startWorkspaceGateway(id: string, registry: WorkspaceRegistry, operations: GatewayStartupOperations): Promise<void> {
  const entry = registry.get(id);
  const step = { workspaceId: id, id: "workspace.gateway", label: "Start workspace gateway" };
  await operations.step?.({ ...step, status: "running" });
  try {
    await operations.checkGateway(id);
  } catch (error) {
    if (registry.get(id) !== entry) return;
    const message = `${error instanceof Error ? error.message : String(error)} Workspace web apps may be unavailable without gateway support.`;
    console.error(`workspace gateway unavailable ${id}`, error);
    registry.setIssue(id, "gateway", message);
    const continuation = operations.waitForContinue(id, step.id);
    await operations.step?.({ ...step, status: "failed", error: message, awaitingContinue: true, continueLabel: "Continue without gateway support" });
    await continuation;
    if (registry.get(id) !== entry) return;
    await operations.step?.({ ...step, status: "failed", detail: "Continuing without gateway support", awaitingContinue: false });
    return;
  }
  if (registry.get(id) !== entry) return;
  registry.setIssue(id, "gateway");
  await operations.step?.({ ...step, status: "done" });
}

interface RecoveryOperations extends GatewayStartupOperations {
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
      await startWorkspaceGateway(id, registry, operations);
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
