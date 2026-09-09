import { basename, dirname, isAbsolute, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { WorkspaceDockerPlan } from "./types.ts";

/** Supplied by the installation owner, not repository configuration. Paths are Docker-host paths. */
export interface SharedDockerRuntime {
  snapshotterSocket: string;
  snapshotterRoot: string;
  bridgeCIDR: string;
  addressPool: string;
  insecureRegistries?: string[];
}

export function sharedDockerConfiguration(runtime: SharedDockerRuntime) {
  for (const path of [runtime.snapshotterSocket, runtime.snapshotterRoot]) {
    if (!isAbsolute(path) || /[\n\r,]/.test(path)) throw new Error("shared Docker paths must be absolute and contain no commas or newlines");
  }
  const socketDirectory = "/run/atelier-snapshotter";
  return {
    socketDirectory,
    containerd: `version = 3
root = "/var/lib/containerd"
state = "/run/containerd"
disabled_plugins = ["io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime"]
[grpc]
  address = "/run/containerd/containerd.sock"
[proxy_plugins.shared-overlay]
  type = "snapshot"
  address = ${JSON.stringify(join(socketDirectory, basename(runtime.snapshotterSocket)))}
`,
    docker: JSON.stringify({
      hosts: ["unix:///run/docker.sock"],
      containerd: "/run/containerd/containerd.sock",
      "containerd-namespace": "moby",
      "containerd-plugins-namespace": "plugins.moby",
      features: { "containerd-snapshotter": true },
      "storage-driver": "shared-overlay",
      "data-root": "/var/lib/docker",
      "exec-root": "/run/docker",
      pidfile: "/run/docker.pid",
      bip: runtime.bridgeCIDR,
      "default-address-pools": [{ base: runtime.addressPool, size: 24 }],
      "insecure-registries": runtime.insecureRegistries ?? [],
    }, null, 2),
  };
}

export async function prepareSharedDocker(plan: WorkspaceDockerPlan, directory: string): Promise<void> {
  const runtime = plan.sharedDocker!;
  if (plan.preloadDockerImages?.length) throw new Error("shared Docker does not support carrier preloading; image prewarming must be integrated separately");
  const config = sharedDockerConfiguration(runtime);
  await mkdir(directory, { recursive: true });
  for (const [name, content] of [["containerd.toml", config.containerd], ["docker-daemon.json", config.docker]] as const) {
    const source = join(directory, name);
    await writeFile(source, content);
    plan.containerFiles.push({ source, target: `/.atelier/${name}` });
  }
  if (!plan.extraArgs.includes("--privileged")) plan.extraArgs.push("--privileged");
  plan.extraArgs.push("--tmpfs", "/run");
  // Bind the directory, not the socket inode, so a restarted adapter can reconnect.
  plan.mounts.push({ type: "bind", source: dirname(runtime.snapshotterSocket), target: config.socketDirectory, readonly: true });
  plan.mounts.push({ type: "bind", source: runtime.snapshotterRoot, target: runtime.snapshotterRoot, propagation: "rslave" });
}
