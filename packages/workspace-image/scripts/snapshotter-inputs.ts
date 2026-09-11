import { readdir } from "node:fs/promises";
import { join, sep } from "node:path";

// Only these modules belong to the workspace executable. The installation's
// implementation and integration tests must not enter its build context/hash.
const directories = [
  "cmd/atelier-workspace-snapshotter",
  "internal/workspace",
  "internal/protocol",
  "internal/process",
];

export function isWorkspaceSnapshotterInput(path: string): boolean {
  const normalized = path.split(sep).join("/");
  return normalized === "go.mod" || normalized === "go.sum"
    || (normalized.endsWith(".go") && directories.some((dir) => normalized.startsWith(`${dir}/`)));
}

export async function workspaceSnapshotterInputs(root: string): Promise<string[]> {
  const files = ["go.mod", "go.sum"];
  async function collect(dir: string): Promise<void> {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && isWorkspaceSnapshotterInput(path)) files.push(path);
    }
  }
  for (const dir of directories) await collect(dir);
  return files.sort();
}
