import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSharedDocker, sharedDockerConfiguration, type SharedDockerRuntime } from "./shared-docker.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

const runtime: SharedDockerRuntime = {
  snapshotterSocket: "/installation/sockets/workspace-a.sock",
  snapshotterRoot: "/installation/snapshots",
  bridgeCIDR: "10.231.0.1/24",
  addressPool: "10.232.0.0/16",
};
function plan(): WorkspaceDockerPlan {
  return { sharedDocker: runtime, labels: {}, env: {}, mounts: [], publishes: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
}

test("private Docker selects its private containerd and the supplied shared snapshotter", () => {
  const config = sharedDockerConfiguration(runtime);
  expect(config.containerd).toContain('address = "/run/atelier-snapshotter/workspace-a.sock"');
  const docker = JSON.parse(config.docker);
  expect(docker.containerd).toBe("/run/containerd/containerd.sock");
  expect(docker["storage-driver"]).toBe("shared-overlay");
  expect(docker.features["containerd-snapshotter"]).toBe(true);
  expect(docker.bip).toBe(runtime.bridgeCIDR);
  expect(docker["insecure-registries"]).toEqual([]);
});

test("provisioning supplies restartable socket mount, same-path backing and ephemeral runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shared-docker-"));
  try {
    const p = plan();
    await prepareSharedDocker(p, directory);
    expect(p.extraArgs).toEqual(["--privileged", "--tmpfs", "/run"]);
    expect(p.mounts).toEqual([
      { type: "bind", source: "/installation/sockets", target: "/run/atelier-snapshotter", readonly: true },
      { type: "bind", source: runtime.snapshotterRoot, target: runtime.snapshotterRoot },
    ]);
    expect(p.containerFiles.map((file) => file.target)).toEqual(["/.atelier/containerd.toml", "/.atelier/docker-daemon.json"]);
    expect(await readFile(p.containerFiles[0]!.source, "utf8")).toBe(sharedDockerConfiguration(runtime).containerd);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("invalid shared paths fail instead of selecting a private cache", () => {
  for (const snapshotterRoot of ["relative", "/storage,readonly", "/storage\ninvalid"]) {
    expect(() => sharedDockerConfiguration({ ...runtime, snapshotterRoot })).toThrow("shared Docker paths");
  }
});

test("carrier preload cannot silently replace a shared runtime", async () => {
  const p = plan();
  p.preloadDockerImages = ["ubuntu:24.04"];
  await expect(prepareSharedDocker(p, "/unused")).rejects.toThrow("carrier preloading");
  expect(p.mounts).toEqual([]);
});
