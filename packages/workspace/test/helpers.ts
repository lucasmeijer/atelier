import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { workspaceWorkHostPath } from "@atelier/workspace";

export interface TestCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function createTestNamespace(prefix = "test"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function docker(args: string[]): Promise<TestCommandResult> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export async function cleanupNamespace(namespace: string): Promise<void> {
  const listed = await docker([
    "ps",
    "-a",
    "--filter",
    "label=com.atelier.type=workspace",
    "--filter",
    `label=com.atelier.namespace=${namespace}`,
    "--format",
    '{{.ID}}\t{{.Label "com.atelier.workspace-id"}}',
  ]);

  if (listed.exitCode !== 0) return;

  const workspaces = listed.stdout.trim().split(/\n+/).filter(Boolean).map((line) => {
    const [containerId, labelledId] = line.split("\t");
    return { containerId: containerId!, workspaceId: labelledId?.trim() || containerId!.slice(0, 8) };
  });
  if (workspaces.length === 0) return;

  const removed = await docker(["rm", "-f", ...workspaces.map(({ containerId }) => containerId)]);
  if (removed.exitCode !== 0) throw new Error(removed.stderr || removed.stdout);
  await Promise.all(workspaces.map(({ workspaceId }) => rm(dirname(workspaceWorkHostPath(workspaceId)), { recursive: true, force: true })));
}
