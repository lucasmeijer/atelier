import { existsSync, readFileSync } from "node:fs";

let cachedAtelierContainerImageId: string | undefined | null;

function runningInContainer(): boolean {
  return existsSync("/.dockerenv");
}

function containerIdCandidates(): string[] {
  const candidates: string[] = [];
  const cgroup = existsSync("/proc/self/cgroup") ? readFileSync("/proc/self/cgroup", "utf8") : "";
  for (const match of cgroup.matchAll(/(?:^|[/:-])([0-9a-f]{64})(?:$|[/.\n])/g)) candidates.push(match[1]!);
  const hostname = existsSync("/etc/hostname") ? readFileSync("/etc/hostname", "utf8").trim() : "";
  if (hostname) candidates.push(hostname);
  return [...new Set(candidates)];
}

function inspectContainerImageId(containerId: string): string | undefined {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["docker", "inspect", "--format", "{{.Image}}", containerId], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return undefined;
  }
  if (result.exitCode !== 0) return undefined;
  return result.stdout?.toString().trim() || undefined;
}

export function currentAtelierContainerImageId(): string | undefined {
  if (cachedAtelierContainerImageId !== undefined) return cachedAtelierContainerImageId ?? undefined;
  if (!runningInContainer()) {
    cachedAtelierContainerImageId = null;
    return undefined;
  }
  for (const containerId of containerIdCandidates()) {
    const imageId = inspectContainerImageId(containerId);
    if (imageId) {
      cachedAtelierContainerImageId = imageId;
      return imageId;
    }
  }
  cachedAtelierContainerImageId = null;
  return undefined;
}
