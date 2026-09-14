import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspaceSystemd } from "./systemd.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

test("provisioning supplies setup and PID 1 requirements without replacing image-owned runtime units", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-systemd-"));
  try {
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], preloadImages: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
    await prepareWorkspaceSystemd(plan, directory, "echo setup");
    expect(plan.extraArgs).toEqual(["--privileged", "--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3"]);
    expect(plan.containerFiles).toEqual([{ source: join(directory, "init.sh"), target: "/.atelier/init.sh" }]);
    expect(await readFile(join(directory, "init.sh"), "utf8")).toBe("echo setup");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
