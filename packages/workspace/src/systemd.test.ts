import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceSystemd, workspaceSystemdUnits } from "./systemd.ts";
import type { SharedDockerRuntime } from "./shared-docker.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

const runtime: SharedDockerRuntime = {
  snapshotterSocket: "/installation/sockets/client.sock", snapshotterRoot: "/installation/store", bridgeCIDR: "10.231.0.1/24", addressPool: "10.232.0.0/16",
};

test("gateway readiness does not require activating Docker", () => {
  for (const shared of [undefined, runtime]) {
    const units = workspaceSystemdUnits(shared);
    expect(units["atelier-gateway.service"]).toContain("Requires=atelier-init.service");
    expect(units["atelier-gateway.service"]).not.toContain("docker");
    expect(units["docker.socket"]).toContain("WantedBy=sockets.target");
    expect(units["docker.service"]).not.toContain("WantedBy=");
    expect(units["docker.service"]).toContain("Restart=on-failure");
    expect(units["docker.service"]).toContain("StartLimitBurst=5");
    expect(units["atelier-init.service"]).toContain("RemainAfterExit=yes");
  }
});

test("shared Docker activates its dependencies without binding gateway lifetime to them", () => {
  const units = workspaceSystemdUnits(runtime);
  expect(units["docker.service"]).toContain("Wants=atelier-containerd.service");
  expect(units["docker.service"]).toContain("After=docker.socket atelier-containerd.service");
  expect(units["atelier-containerd.service"]).toContain("Wants=atelier-snapshotter.service");
  expect(units["atelier-containerd.service"]).toContain("KillMode=process");
  expect(units["atelier-snapshotter.service"]).toContain("Restart=on-failure");
  expect(workspaceSystemdUnits()["docker.service"]).toContain("-H fd:// --live-restore");
});

test("provisioning preserves initialization scripts and supplies PID 1 runtime requirements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-systemd-"));
  try {
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], publishes: [], extraArgs: ["--privileged"], initScripts: [], containerFiles: [], cleanup: [] };
    const init = "set -eu\nprintf 'project setup\\n'\n";
    await prepareWorkspaceSystemd(plan, directory, init);
    expect(plan.extraArgs).toEqual(["--privileged", "--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3"]);
    expect(plan.containerFiles.map(file => file.target)).toContain("/.atelier/init.sh");
    expect(await readFile(join(directory, "init.sh"), "utf8")).toBe(init);
    expect(plan.containerFiles).toHaveLength(5);
    expect(await readFile(join(directory, "docker.service"), "utf8")).toBe(workspaceSystemdUnits()["docker.service"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registry relay is socket activated and ordered before Docker without starting Docker for HTTP clients", async () => {
  const shared = { ...runtime, registrySocket: "/installation/sockets/registry.sock" };
  const units = workspaceSystemdUnits(shared);
  expect(units["atelier-registry.socket"]).toContain("ListenStream=127.0.0.1:42000");
  expect(units["atelier-registry.socket"]).toContain("WantedBy=sockets.target");
  expect(units["atelier-registry.service"]).toContain(`systemd-socket-proxyd "${shared.registrySocket}"`);
  expect(units["atelier-registry.service"]).not.toContain("docker");
  expect(units["atelier-registry.service"]).not.toContain("WantedBy=");
  expect(units["docker.service"]).toContain("Wants=atelier-containerd.service atelier-registry.service");
  expect(units["docker.service"]).toContain("After=docker.socket atelier-containerd.service atelier-registry.service");
  expect(units["docker.service"]).toContain("Requires=docker.socket atelier-registry.socket");
  expect(workspaceSystemdUnits(runtime)["atelier-registry.socket"]).toBeUndefined();

  const directory = await mkdtemp(join(tmpdir(), "workspace-relay-"));
  try {
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], publishes: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [], sharedDocker: shared };
    await prepareWorkspaceSystemd(plan, directory, "true");
    expect(await readFile(join(directory, "atelier-registry.service"), "utf8")).toBe(units["atelier-registry.service"]);
  } finally { await rm(directory, { recursive: true }); }
});

test("the adapter executes directly with literal socket paths", () => {
  const units = workspaceSystemdUnits({ ...runtime, snapshotterSocket: '/installation/a % $ " \\ path/client.sock' });
  expect(units["atelier-snapshotter.service"]).toContain('ExecStart=:/usr/local/bin/atelier-workspace-snapshotter');
  expect(units["atelier-snapshotter.service"]).toContain('--shared-socket "/installation/a %% $ \\" \\\\ path/client.sock"');
});
