import { AtelierCoreError, type JsonValue } from "@atelier/core";
import type { DeleteCurrentWorkspaceResult, WorkspaceDeletionAssessment } from "@atelier/shared";
import type { WorkspaceDeletionState, WorkspaceRegistry } from "./workspace-registry.ts";

/** Owns deletion assessment, confirmation, retries, and restart recovery. */
export function createWorkspaceDeletion(options: {
  registry: WorkspaceRegistry;
  inspect(id: string): Promise<WorkspaceDeletionAssessment>;
  destroy(id: string): Promise<void>;
  changed(id: string, state: WorkspaceDeletionState): void | Promise<void>;
}) {
  const { registry } = options;
  const evidence = new Map<string, JsonValue>();

  function requireWorkspace(id: string) {
    const entry = registry.get(id);
    if (!entry) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
    return entry;
  }

  function canRequest(id: string): boolean {
    const entry = requireWorkspace(id);
    if (!entry.deletion) return entry.phase === "ready" || entry.phase === "failed";
    return entry.deletion.status === "blocked" || entry.deletion.status === "failed";
  }

  function setState(id: string, state: WorkspaceDeletionState): void | Promise<void> {
    if (state.status === "blocked") registry.markViewAttention(id, "workspace");
    registry.setDeletion(id, state);
    if (state.status === "failed") registry.markViewAttention(id, "workspace");
    return options.changed(id, state);
  }

  async function destroy(id: string, forced: boolean): Promise<string | undefined> {
    await setState(id, { status: "deleting", forced });
    try {
      await options.destroy(id);
      evidence.delete(id);
      registry.remove(id);
      return undefined;
    } catch (error) {
      console.error(`Workspace ${id} deletion failed`, error);
      const message = error instanceof Error ? error.message : String(error);
      await setState(id, { status: "failed", forced, operation: "deleting", error: message });
      return message;
    }
  }

  function schedule(id: string, forced: boolean): DeleteCurrentWorkspaceResult {
    void destroy(id, forced);
    return { deleted: true, blocked: false };
  }

  async function check(id: string, confirmedFingerprint?: string): Promise<DeleteCurrentWorkspaceResult> {
    await setState(id, { status: "checking" });
    try {
      const assessment = await options.inspect(id);
      if (assessment.status === "blocked") {
        if (assessment.fingerprint === confirmedFingerprint) return schedule(id, true);
        evidence.set(id, assessment.details);
        await setState(id, { status: "blocked", fingerprint: assessment.fingerprint });
        return { deleted: false, blocked: true, details: assessment.details };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setState(id, { status: "failed", operation: "checking", error: message });
      return { deleted: false, blocked: false };
    }
    return schedule(id, false);
  }

  async function request(id: string, input: { force?: boolean; fingerprint?: string } = {}): Promise<DeleteCurrentWorkspaceResult> {
    const entry = requireWorkspace(id);
    if (input.fingerprint !== undefined) {
      if (entry.deletion?.status !== "blocked" || entry.deletion.fingerprint !== input.fingerprint) throw new AtelierCoreError("workspace_not_ready", "The deletion assessment is no longer current");
      return check(id, input.fingerprint);
    }
    if (!canRequest(id)) throw new AtelierCoreError("workspace_not_ready", `workspace ${id} is not ready for deletion`);
    if (entry.deletion?.status === "blocked" && !input.force) return { deleted: false, blocked: true, details: evidence.get(id) };
    const retryForced = entry.deletion?.status === "failed" && entry.deletion.operation === "deleting" ? entry.deletion.forced : undefined;
    if (input.force || (entry.phase === "failed" && !entry.deletion) || retryForced !== undefined) return schedule(id, input.force === true || retryForced === true);
    return check(id);
  }

  return {
    request,
    canRequest,
    evidence(id: string): JsonValue | undefined {
      return evidence.get(id);
    },
    cancel(id: string): boolean {
      const entry = requireWorkspace(id);
      if (entry.deletion?.status !== "blocked" && entry.deletion?.status !== "failed") return false;
      registry.setDeletion(id, undefined);
      evidence.delete(id);
      registry.clearViewAttention(id, "workspace");
      return true;
    },
    resume(): void {
      for (const entry of registry.list()) {
        if (entry.deletion?.status === "checking") void check(entry.id);
        else if (entry.deletion?.status === "deleting") schedule(entry.id, entry.deletion.forced);
      }
    },
    async destroyAll(ids: readonly string[]): Promise<{ deleted: number; errors: string[] }> {
      const errors: string[] = [];
      let deleted = 0;
      for (const id of ids) {
        const error = await destroy(id, true);
        if (error) errors.push(`${id}: ${error}`);
        else deleted += 1;
      }
      return { deleted, errors };
    },
  };
}
