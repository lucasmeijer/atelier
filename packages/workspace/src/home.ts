import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { atelierDataPath, createProcessFileLock, dockerHostAtelierDataPath, getAtelierRuntimeContext, requireDocker } from "@atelier/core";
import { ensureDefaultWorkspaceImage } from "@atelier/workspace-image";
import type { WorkspaceDockerMount } from "./types.ts";

const withHomeLock = createProcessFileLock({
  lockDir: () => atelierDataPath(getAtelierRuntimeContext(), "home.lock"),
  label: "shared home initialization",
});

/** Publish a complete home once; deleted defaults are never restored on later starts. */
export async function ensureSharedHome(): Promise<void> {
  const runtime = getAtelierRuntimeContext();
  const home = atelierDataPath(runtime, "home");
  if (existsSync(home)) return;
  // Image acquisition can take minutes; don't hold the short-lived filesystem lock.
  const image = await ensureDefaultWorkspaceImage();
  await withHomeLock(async () => {
    if (existsSync(home)) return;
    const staging = await mkdtemp(atelierDataPath(runtime, ".home-seed-"));
    const container = `atelier-home-seed-${crypto.randomUUID()}`;
    try {
      await requireDocker(["create", "--name", container, "--entrypoint", "/bin/true", image]);
      try {
        // docker cp assigns files to the invoking host user, rather than the image UID.
        await requireDocker(["cp", `${container}:/opt/atelier/home-defaults/.`, staging]);
      } finally {
        await requireDocker(["rm", container]);
      }
      await chmod(staging, 0o700);
      await rename(staging, home);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

export async function workspaceHomeMounts(workspaceId: string): Promise<WorkspaceDockerMount[]> {
  await ensureSharedHome();
  const runtime = getAtelierRuntimeContext();
  const mounts: WorkspaceDockerMount[] = [{ type: "bind", source: dockerHostAtelierDataPath(runtime, "home"), target: "/home/atelier" }];
  for (const path of [".local/share", ".local/state", ".cache"]) {
    // Pre-create mountpoints as the host user, not as Docker's root user.
    await mkdir(atelierDataPath(runtime, "home", path), { recursive: true });
    await mkdir(atelierDataPath(runtime, "workspaces", workspaceId, "home-local", path), { recursive: true, mode: 0o700 });
    mounts.push({ type: "bind", source: dockerHostAtelierDataPath(runtime, "workspaces", workspaceId, "home-local", path), target: `/home/atelier/${path}` });
  }
  return mounts;
}
