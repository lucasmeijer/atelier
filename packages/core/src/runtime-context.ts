import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { runDocker } from "./docker.ts";
import { defaultDataDir } from "./data-dir.ts";

export interface AtelierRuntimeContext {
  /** Path as seen by the Atelier process itself. Use this for normal Atelier file IO. */
  atelierDataDir: string;
  /** Same directory as seen by the Docker daemon. Use this for Docker bind mount sources. */
  dockerHostAtelierDataDir: string;
  /** Docker network shared by the Atelier container and sibling workspace containers, when detectable. */
  dockerNetwork?: string;
  /** Address/name workspaces can use to reach the Atelier container on dockerNetwork, when detectable. */
  dockerNetworkHost?: string;
  /** Docker host gateway address as seen from containers on the fallback bridge network, when detectable. */
  dockerHostGateway?: string;
  /** Diagnostic flag; application code should generally rely on the fields above instead. */
  runningInContainer: boolean;
}

interface DockerMount {
  Type?: string;
  Source?: string;
  Destination?: string;
}

interface DockerNetworkAttachment {
  IPAddress?: string;
  Gateway?: string;
  Aliases?: string[] | null;
}

interface DockerContainerInspect {
  Id?: string;
  Name?: string;
  Mounts?: DockerMount[];
  NetworkSettings?: { Networks?: Record<string, DockerNetworkAttachment> };
}

let cachedRuntimeContext: { atelierDataDir: string; context: Promise<AtelierRuntimeContext> } | undefined;

export function atelierDataPath(context: AtelierRuntimeContext, ...segments: string[]): string {
  return join(context.atelierDataDir, ...segments);
}

export function dockerHostAtelierDataPath(context: AtelierRuntimeContext, ...segments: string[]): string {
  return join(context.dockerHostAtelierDataDir, ...segments);
}

export function getAtelierRuntimeContext(): Promise<AtelierRuntimeContext> {
  const atelierDataDir = defaultDataDir();
  if (!cachedRuntimeContext || cachedRuntimeContext.atelierDataDir !== atelierDataDir) {
    cachedRuntimeContext = { atelierDataDir, context: discoverAtelierRuntimeContext(atelierDataDir) };
  }
  return cachedRuntimeContext.context;
}

export function resetAtelierRuntimeContextForTests(): void {
  cachedRuntimeContext = undefined;
}

export async function discoverAtelierRuntimeContext(atelierDataDir = defaultDataDir()): Promise<AtelierRuntimeContext> {
  if (!probablyRunningInContainer()) {
    return { atelierDataDir, dockerHostAtelierDataDir: atelierDataDir, runningInContainer: false };
  }

  const inspected = await inspectSelfContainer();
  const dockerHostAtelierDataDir = inspected?.Mounts ? translateContainerPathToDockerHostPath(atelierDataDir, inspected.Mounts) ?? atelierDataDir : atelierDataDir;
  const network = chooseDockerNetwork(inspected);
  return {
    atelierDataDir,
    dockerHostAtelierDataDir,
    ...(network ? { dockerNetwork: network.name, dockerNetworkHost: network.host } : {}),
    ...(dockerHostGateway(inspected) ? { dockerHostGateway: dockerHostGateway(inspected) } : {}),
    runningInContainer: true,
  };
}

const containerPathPattern = /docker|containerd|kubepods|podman|containers\//i;

function probablyRunningInContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env.container) return true;
  return ["/proc/self/cgroup", "/proc/1/cgroup"].some(fileContainsContainerPath)
    || ["/proc/self/mountinfo", "/proc/1/mountinfo"].some(rootMountContainsContainerPath);
}

function fileContainsContainerPath(path: string): boolean {
  return existsSync(path) && containerPathPattern.test(readFileSync(path, "utf8"));
}

function rootMountContainsContainerPath(path: string): boolean {
  return existsSync(path) && rootMountinfoLines(readFileSync(path, "utf8")).some((line) => containerPathPattern.test(line));
}

function rootMountinfoLines(text: string): string[] {
  return text.split("\n").filter((line) => line.split(" ")[4] === "/");
}

async function inspectSelfContainer(): Promise<DockerContainerInspect | undefined> {
  const candidates = containerIdCandidates();
  for (const id of candidates) {
    const inspected = await runDocker(["inspect", "--format", "{{json .}}", id]).catch(() => undefined);
    if (!inspected || inspected.exitCode !== 0) continue;

    try {
      const parsed = JSON.parse(inspected.stdout.trim()) as unknown;
      if (parsed && typeof parsed === "object") return parsed as DockerContainerInspect;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function dockerHostGateway(inspected: DockerContainerInspect | undefined): string | undefined {
  const networks = inspected?.NetworkSettings?.Networks;
  return networks ? Object.values(networks).find((network) => network.Gateway)?.Gateway : undefined;
}

function chooseDockerNetwork(inspected: DockerContainerInspect | undefined): { name: string; host: string } | undefined {
  const networks = inspected?.NetworkSettings?.Networks;
  if (!networks) return undefined;
  const entries = Object.entries(networks).filter(([name]) => name !== "bridge" && name !== "host" && name !== "none");
  const [name, attachment] = entries[0] ?? [];
  if (!name || !attachment) return undefined;

  const id = inspected?.Id?.toLowerCase() ?? "";
  const containerName = inspected?.Name?.replace(/^\//, "");
  const stableAlias = (attachment.Aliases ?? [])
    .filter(Boolean)
    .find((alias) => alias !== containerName && alias.toLowerCase() !== id && alias.toLowerCase() !== id.slice(0, 12));
  const host = stableAlias || containerName || attachment.IPAddress;
  return host ? { name, host } : undefined;
}

function containerIdCandidates(): string[] {
  const candidates = new Set<string>();
  if (process.env.ATELIER_CONTAINER_ID) candidates.add(process.env.ATELIER_CONTAINER_ID);
  if (process.env.HOSTNAME) candidates.add(process.env.HOSTNAME);
  candidates.add(hostname());

  for (const path of ["/proc/self/cgroup", "/proc/1/cgroup"]) addContainerIds(candidates, existsSync(path) ? readFileSync(path, "utf8") : "");
  for (const path of ["/proc/self/mountinfo", "/proc/1/mountinfo"]) addContainerIds(candidates, existsSync(path) ? rootMountinfoLines(readFileSync(path, "utf8")).join("\n") : "");

  return [...candidates].filter(Boolean);
}

function addContainerIds(candidates: Set<string>, text: string): void {
  for (const match of text.matchAll(/[0-9a-f]{64}/gi)) candidates.add(match[0]);
}

function translateContainerPathToDockerHostPath(containerPath: string, mounts: DockerMount[]): string | undefined {
  const matchingMounts = mounts
    .filter((mount): mount is Required<Pick<DockerMount, "Source" | "Destination">> => Boolean(mount.Source && mount.Destination))
    .filter((mount) => pathIsAtOrWithin(containerPath, mount.Destination!))
    .sort((a, b) => b.Destination.length - a.Destination.length);

  const match = matchingMounts[0];
  if (!match) return undefined;

  const suffix = containerPath.slice(match.Destination.length);
  return join(match.Source, suffix);
}

function pathIsAtOrWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}
