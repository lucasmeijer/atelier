import { runDocker } from "@atelier/core";
import { dockerImageStoreQueue } from "./image-store-queue.ts";

export type WorkspaceImageKind = "default" | "repository";

export const workspaceImageKindLabel = "com.atelier.workspace-image.kind";

export function workspaceImagePruneArgs(kind: WorkspaceImageKind, buildStartedAt: Date): string[] {
  return [
    "image", "prune", "--all", "--force",
    "--filter", `label=${workspaceImageKindLabel}=${kind}`,
    "--filter", `until=${Math.floor(buildStartedAt.getTime() / 1000) - 1}`,
  ];
}

/**
 * Pruning is detached from the workspace that requested cleanup. The image-store
 * queue keeps it from overlapping later provisioning while preserving FIFO order.
 */
export function pruneSupersededWorkspaceImages(kind: WorkspaceImageKind, buildStartedAt: Date): void {
  void dockerImageStoreQueue.run({ label: `Pruning old ${kind} workspace images` }, () => runDocker(workspaceImagePruneArgs(kind, buildStartedAt))).then((result) => {
    if (result.exitCode !== 0) console.warn(`[workspace-image] background prune failed: ${result.stderr.trim()}`);
  }).catch((error) => {
    console.warn(`[workspace-image] background prune failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
