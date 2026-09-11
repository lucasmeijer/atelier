import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceSystemd, workspaceSystemdUnits } from "./systemd.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

test("gateway readiness does not require activating Docker", () => {
  for (const shared of [false, true]) {
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
  const units = workspaceSystemdUnits(true);
  if (!("atelier-containerd.service" in units) || !("atelier-snapshotter.service" in units)) throw new Error("shared units missing");
  expect(units["docker.service"]).toContain("Wants=atelier-containerd.service");
  expect(units["docker.service"]).toContain("After=docker.socket atelier-containerd.service");
  expect(units["atelier-containerd.service"]).toContain("Wants=atelier-snapshotter.service");
  expect(units["atelier-containerd.service"]).toContain("KillMode=process");
  expect(units["atelier-snapshotter.service"]).toContain("Restart=on-failure");
  expect(workspaceSystemdUnits(false)["docker.service"]).toContain("-H fd:// --live-restore");
});

test("provisioning preserves initialization scripts and supplies PID 1 runtime requirements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-systemd-"));
  try {
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], publishes: [], extraArgs: ["--privileged"], initScripts: [], containerFiles: [], cleanup: [] };
    const init = "set -eu\nprintf 'project setup\\n'\n";
    await prepareWorkspaceSystemd(plan, directory, init);
    expect(plan.extraArgs).toEqual(["--privileged", "--cgroupns=private", "--tmpfs", "/run", "--tmpfs", "/run/lock", "--stop-signal", "SIGRTMIN+3"]);
    expect(plan.containerFiles.map(file => file.target)).toContain("/.atelier/init.sh");
    expect(await readFile(join(directory, "init.sh"), "utf8")).toBe(init);
    expect(plan.containerFiles).toHaveLength(5);
    expect(await readFile(join(directory, "docker.service"), "utf8")).toBe(workspaceSystemdUnits(false)["docker.service"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
