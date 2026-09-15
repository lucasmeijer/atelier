import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceDockerPlan } from "./types.ts";

/** Runtime units live in the image; each workspace supplies only its setup script. */
export async function prepareWorkspaceSystemd(plan: WorkspaceDockerPlan, directory: string, init: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const source = join(directory, "init.sh");
  await writeFile(source, init);
  plan.containerFiles.push({ source, target: "/.atelier/init.sh" });
  if (!plan.extraArgs.includes("--privileged")) plan.extraArgs.push("--privileged");
  plan.extraArgs.push("--cgroupns=private", "--tmpfs", "/run", "--stop-signal", "SIGRTMIN+3");
}
