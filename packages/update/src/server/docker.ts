import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { hostname } from "node:os";
import { isReleaseChannel, targetImageForChannel, type ReleaseChannel } from "./channels.ts";
import { repository } from "./constants.ts";

export interface DockerExecResult { stdout: string; stderr: string; code: number }
export interface DockerExec { (args: string[]): Promise<DockerExecResult> }

export const dockerExec: DockerExec = async (args) => {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
};

export function parseContainerIdFromCgroup(text: string): string | undefined {
  const patterns = [
    /(?:^|[/:])docker[-/]([0-9a-f]{64})(?:\.scope)?(?:\n|$)/m,
    /(?:^|[/:])docker-([0-9a-f]{64})\.scope(?:\n|$)/m,
    /(?:^|[/:])cri-containerd-([0-9a-f]{64})\.scope(?:\n|$)/m,
    /(?:^|[/:])([0-9a-f]{64})(?:\n|$)/m,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function parseContainerIdFromMountInfo(text: string): string | undefined {
  const match = text.match(/\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)(?:\s|$)/);
  return match?.[1];
}

export async function ownContainerId(): Promise<string | undefined> {
  const cgroup = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  return parseContainerIdFromCgroup(cgroup) ?? parseContainerIdFromMountInfo(mountInfo) ?? hostname();
}

export interface DockerMount {
  Type?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}

export interface DockerRestartPolicy {
  Name?: string;
  MaximumRetryCount?: number;
}

export interface DockerHostConfig {
  Binds?: string[];
  Mounts?: DockerMount[];
  NetworkMode?: string;
  RestartPolicy?: DockerRestartPolicy;
  Init?: boolean;
  CpuShares?: number;
  MemoryReservation?: number;
  OomScoreAdj?: number;
}

export interface DockerInspect {
  Id: string;
  Name?: string;
  Image: string;
  RepoDigests?: string[];
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string>; Entrypoint?: string[] | string | null; Cmd?: string[] | string | null; WorkingDir?: string; User?: string };
  ImageConfig?: { Config?: { Labels?: Record<string, string> } };
  HostConfig?: DockerHostConfig;
  Mounts?: DockerMount[];
  NetworkSettings?: unknown;
}

export async function dockerInspect(id: string, exec: DockerExec = dockerExec): Promise<DockerInspect> {
  const result = await exec(["inspect", id]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `docker inspect failed for ${id}`);
  const parsed = JSON.parse(result.stdout) as DockerInspect[];
  if (!parsed[0]) throw new Error(`docker inspect returned no result for ${id}`);
  return parsed[0];
}

export function labelsFromInspect(inspect: DockerInspect): Record<string, string> {
  return { ...(inspect.ImageConfig?.Config?.Labels ?? {}), ...(inspect.Config?.Labels ?? {}) };
}

export function isAtelierImageRef(value: string | undefined): boolean {
  return Boolean(value && /(^|\/|@)ghcr\.io\/lucasmeijer\/atelier(?::|@|$)/.test(value));
}

export function inspectRevision(inspect: DockerInspect): string | undefined {
  return labelsFromInspect(inspect)["org.opencontainers.image.revision"];
}

export function inspectSelfUpdateCompatibility(inspect: DockerInspect): string | undefined {
  return labelsFromInspect(inspect)["com.atelier.self-update-compatibility"];
}

export interface SelfUpdateRuntime { container: DockerInspect; containerId: string; imageId: string; releaseChannel: ReleaseChannel; currentRevision?: string; currentDigest?: string; selfUpdateCompatibility?: string }

function atelierRepoDigest(inspect: DockerInspect): string | undefined {
  return inspect.RepoDigests?.find((digest) => digest.startsWith("ghcr.io/lucasmeijer/atelier@"))?.split("@")[1];
}

export function releaseChannelFromInspect(inspect: DockerInspect): ReleaseChannel {
  const label = inspect.Config?.Labels?.["com.atelier.release-channel"];
  if (isReleaseChannel(label)) return label;
  const image = inspect.Config?.Image ?? "";
  if (image.endsWith(":latest")) return "latest";
  return "stable";
}

function envValue(env: string[] | undefined, name: string): string | undefined {
  const prefix = `${name}=`;
  return env?.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

export function serverHealthUrlFromInspect(inspect: DockerInspect, fallbackUrl: string): URL {
  const env = inspect.Config?.Env;
  const host = envValue(env, "HOST");
  if (!host || host === "0.0.0.0" || host === "::") return new URL("/up", fallbackUrl);
  const port = Number(envValue(env, "PORT") ?? 3000);
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${formattedHost}${port === 80 ? "" : `:${port}`}/up`);
}

export async function detectSelfUpdateRuntime(exec: DockerExec = dockerExec): Promise<SelfUpdateRuntime | undefined> {
  const ps = await exec(["version", "--format", "{{.Server.Version}}"]);
  if (ps.code !== 0) return undefined;
  const id = await ownContainerId();
  if (!id) return undefined;
  const container = await dockerInspect(id, exec).catch(() => undefined);
  if (!container) return undefined;
  const labels = container.Config?.Labels ?? {};
  if (labels["com.atelier.type"] !== "server") return undefined;
  const image = await dockerInspect(container.Image, exec).catch(() => undefined);
  const repoDigest = atelierRepoDigest(image ?? container) ?? atelierRepoDigest(container);
  if (!isAtelierImageRef(container.Config?.Image) && !repoDigest) return undefined;
  return {
    container,
    containerId: container.Id,
    imageId: container.Image,
    releaseChannel: releaseChannelFromInspect(container),
    currentRevision: inspectRevision(image ?? container) ?? inspectRevision(container),
    currentDigest: repoDigest ?? container.Image,
    selfUpdateCompatibility: inspectSelfUpdateCompatibility(image ?? container) ?? inspectSelfUpdateCompatibility(container),
  };
}

export interface PullProgress { kind: "progress"; percent?: number; message?: string }

type DockerPullEvent = { id?: string; status?: string; progressDetail?: { current?: number; total?: number }; error?: string };
type PullLayer = { current: number; total: number };

function dockerApiImageCreatePath(channel: ReleaseChannel): string {
  return `/images/create?${new URLSearchParams({ fromImage: `ghcr.io/${repository}`, tag: channel }).toString()}`;
}

function pullPercent(layers: Map<string, PullLayer>): number | undefined {
  let current = 0;
  let total = 0;
  for (const layer of layers.values()) {
    current += Math.min(layer.current, layer.total);
    total += layer.total;
  }
  return total > 0 ? Math.max(1, Math.min(99, Math.round((current / total) * 100))) : undefined;
}

function recordPullEvent(line: string, layers: Map<string, PullLayer>): PullProgress {
  const event = JSON.parse(line) as DockerPullEvent;
  if (event.error) throw new Error(event.error);
  if (event.id && event.progressDetail?.total) layers.set(event.id, { current: event.progressDetail.current ?? 0, total: event.progressDetail.total });
  if (event.id && (event.status === "Pull complete" || event.status === "Already exists") && layers.has(event.id)) {
    const layer = layers.get(event.id)!;
    layers.set(event.id, { current: layer.total, total: layer.total });
  }
  return { kind: "progress", percent: pullPercent(layers), message: event.status };
}

export async function pullChannelImage(channel: ReleaseChannel, onProgress: (progress: PullProgress) => void): Promise<void> {
  const layers = new Map<string, PullLayer>();
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: "/var/run/docker.sock", path: dockerApiImageCreatePath(channel), method: "POST" }, (res) => {
      let buffer = "";
      let errorBody = "";
      res.setEncoding("utf8");
      const emitLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed) onProgress(recordPullEvent(trimmed, layers));
      };
      res.on("data", (chunk: string) => {
        if ((res.statusCode ?? 500) >= 400) {
          errorBody += chunk;
          return;
        }
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) emitLine(line);
      });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(errorBody.trim() || `Docker image create failed with HTTP ${res.statusCode}`));
        else {
          emitLine(buffer);
          resolve();
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  onProgress({ kind: "progress", percent: 100 });
}

function shouldPreserveContainerEnv(env: string): boolean {
  const name = env.split("=", 1)[0];
  return name !== "ATELIER_COMMIT_ID" && name !== "ATELIER_COMMIT_DESCRIPTION";
}

function shouldPreserveContainerLabel(key: string): boolean {
  return !key.startsWith("org.opencontainers.image.");
}

export function replacementCreateArgs(inspect: DockerInspect, targetImage = inspect.Config?.Image ?? targetImageForChannel(releaseChannelFromInspect(inspect)), releaseChannel = releaseChannelFromInspect(inspect)): string[] {
  const name = (inspect.Name ?? "atelier").replace(/^\//, "");
  const args = ["create", "--name", name];
  for (const env of inspect.Config?.Env ?? []) if (shouldPreserveContainerEnv(env)) args.push("--env", env);
  const labels = Object.fromEntries(Object.entries(inspect.Config?.Labels ?? {}).filter(([key]) => shouldPreserveContainerLabel(key)));
  for (const [key, value] of Object.entries({ ...labels, "com.atelier.release-channel": releaseChannel })) args.push("--label", `${key}=${value}`);
  for (const mount of inspect.Mounts ?? []) {
    if (mount.Type === "bind" && mount.Source && mount.Destination) args.push("--mount", `type=bind,src=${mount.Source},dst=${mount.Destination}${mount.RW === false ? ",readonly" : ""}`);
    if (mount.Type === "volume" && mount.Source && mount.Destination) args.push("--mount", `type=volume,src=${mount.Source},dst=${mount.Destination}${mount.RW === false ? ",readonly" : ""}`);
  }
  const networkMode = inspect.HostConfig?.NetworkMode;
  if (typeof networkMode === "string" && networkMode) args.push("--network", networkMode);
  if (inspect.HostConfig?.Init) args.push("--init");
  if (inspect.HostConfig?.CpuShares) args.push("--cpu-shares", String(inspect.HostConfig.CpuShares));
  if (inspect.HostConfig?.MemoryReservation) args.push("--memory-reservation", String(inspect.HostConfig.MemoryReservation));
  if (inspect.HostConfig?.OomScoreAdj) args.push("--oom-score-adj", String(inspect.HostConfig.OomScoreAdj));
  const restart = inspect.HostConfig?.RestartPolicy;
  if (restart?.Name) args.push("--restart", restart.Name === "on-failure" && restart.MaximumRetryCount ? `${restart.Name}:${restart.MaximumRetryCount}` : restart.Name);
  if (inspect.Config?.WorkingDir) args.push("--workdir", inspect.Config.WorkingDir);
  if (inspect.Config?.User) args.push("--user", inspect.Config.User);
  args.push(targetImage);
  const cmd = inspect.Config?.Cmd;
  if (Array.isArray(cmd)) args.push(...cmd);
  return args;
}
