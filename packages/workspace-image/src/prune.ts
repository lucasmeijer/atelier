import { runDocker } from "@atelier/core";

export type WorkspaceImageKind = "default" | "repository" | "carrier";

export const workspaceImageKindLabel = "com.atelier.workspace-image.kind";

export function workspaceImagePruneArgs(kind: WorkspaceImageKind, buildStartedAt: Date): string[] {
  return [
    "image", "prune", "--all", "--force",
    "--filter", `label=${workspaceImageKindLabel}=${kind}`,
    "--filter", `until=${Math.floor(buildStartedAt.getTime() / 1000)}`,
  ];
}

/**
 * Pruning is deliberately detached from provisioning. Docker protects images
 * used by containers, and the timestamp keeps this build and concurrent builds
 * out of the prune set.
 */
export function pruneSupersededWorkspaceImages(kind: WorkspaceImageKind, buildStartedAt: Date): void {
  void runDocker(workspaceImagePruneArgs(kind, buildStartedAt)).then((result) => {
    if (result.exitCode !== 0) console.warn(`[workspace-image] background prune failed: ${result.stderr.trim()}`);
  }).catch((error) => {
    console.warn(`[workspace-image] background prune failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
