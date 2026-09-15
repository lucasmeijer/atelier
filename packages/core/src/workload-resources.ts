import { readFile } from "node:fs/promises";
const descriptor = "/run/atelier-system/resources.json";
async function resources(): Promise<
  { workloadsCgroupParent: string } | undefined
> {
  try {
    return JSON.parse(await readFile(descriptor, "utf8"));
  } catch (error) {
    // A developer's local Docker context has no System-owned workload group.
    if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
    throw error;
  }
}
export async function workloadBuildArgs(): Promise<string[]> {
  const config = await resources();
  return config ? ["--cgroup-parent", config.workloadsCgroupParent] : [];
}
export async function workloadCommand(args: string[]): Promise<string[]> {
  if (!(await resources())) return args;
  // Move only this child before exec; the app and its other requests stay protected.
  return [
    "sh",
    "-ec",
    'echo $$ > /run/atelier-system/workload-processes/cgroup.procs; exec "$@"',
    "atelier-workload",
    ...args,
  ];
}
