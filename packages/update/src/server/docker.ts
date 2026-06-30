import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isReleaseChannel, targetImageForChannel, type ReleaseChannel } from "./channels.ts";

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

export interface DockerInspect {
  Id: string;
  Name?: string;
  Image: string;
  RepoDigests?: string[];
  Config?: { Image?: string; Env?: string[]; Labels?: Record<string, string>; Entrypoint?: string[] | string | null; Cmd?: string[] | string | null; WorkingDir?: string; User?: string };
  ImageConfig?: { Config?: { Labels?: Record<string, string> } };
  HostConfig?: Record<string, unknown> & { Binds?: string[]; Mounts?: unknown[]; NetworkMode?: string; RestartPolicy?: unknown; Init?: boolean };
  Mounts?: unknown[];
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

export interface SelfUpdateRuntime { container: DockerInspect; containerId: string; imageId: string; releaseChannel: ReleaseChannel; currentRevision?: string; currentDigest?: string }

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
  return { container, containerId: container.Id, imageId: container.Image, releaseChannel: releaseChannelFromInspect(container), currentRevision: inspectRevision(image ?? container) ?? inspectRevision(container), currentDigest: repoDigest ?? container.Image };
}

export interface PullProgress { kind: "progress"; percent?: number; message?: string }

export async function pullChannelImage(channel: ReleaseChannel, onProgress: (progress: PullProgress) => void, execCommand = (args: string[]) => Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })): Promise<void> {
  const proc = execCommand(["pull", targetImageForChannel(channel)]);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const layers = new Map<string, { current: number; total: number }>();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("{")) {
        onProgress({ kind: "progress", message: trimmed });
        continue;
      }
      const event = JSON.parse(trimmed) as { id?: string; status?: string; progressDetail?: { current?: number; total?: number }; error?: string };
      if (event.error) throw new Error(event.error);
      if (event.id && event.progressDetail?.total) layers.set(event.id, { current: event.progressDetail.current ?? 0, total: event.progressDetail.total });
      const totals = Array.from(layers.values());
      const total = totals.reduce((sum, layer) => sum + layer.total, 0);
      const current = totals.reduce((sum, layer) => sum + Math.min(layer.current, layer.total), 0);
      onProgress({ kind: "progress", percent: total > 0 ? Math.max(1, Math.min(99, Math.round((current / total) * 100))) : undefined, message: event.status });
    }
  }
  const code = await proc.exited;
  if (code !== 0) throw new Error(await new Response(proc.stderr).text() || "docker pull failed");
  onProgress({ kind: "progress", percent: 100 });
}

export function replacementCreateArgs(inspect: DockerInspect, targetImage = inspect.Config?.Image ?? targetImageForChannel(releaseChannelFromInspect(inspect)), releaseChannel = releaseChannelFromInspect(inspect)): string[] {
  const name = (inspect.Name ?? "atelier").replace(/^\//, "");
  const args = ["create", "--name", name];
  for (const env of inspect.Config?.Env ?? []) args.push("--env", env);
  for (const [key, value] of Object.entries({ ...(inspect.Config?.Labels ?? {}), "com.atelier.release-channel": releaseChannel })) args.push("--label", `${key}=${value}`);
  for (const mount of inspect.Mounts ?? []) {
    const m = mount as { Type?: string; Source?: string; Destination?: string; RW?: boolean };
    if (m.Type === "bind" && m.Source && m.Destination) args.push("--mount", `type=bind,src=${m.Source},dst=${m.Destination}${m.RW === false ? ",readonly" : ""}`);
    if (m.Type === "volume" && m.Source && m.Destination) args.push("--mount", `type=volume,src=${m.Source},dst=${m.Destination}${m.RW === false ? ",readonly" : ""}`);
  }
  const networkMode = inspect.HostConfig?.NetworkMode;
  if (typeof networkMode === "string" && networkMode) args.push("--network", networkMode);
  if (inspect.HostConfig?.Init) args.push("--init");
  const restart = inspect.HostConfig?.RestartPolicy as { Name?: string; MaximumRetryCount?: number } | undefined;
  if (restart?.Name) args.push("--restart", restart.Name === "on-failure" && restart.MaximumRetryCount ? `${restart.Name}:${restart.MaximumRetryCount}` : restart.Name);
  if (inspect.Config?.WorkingDir) args.push("--workdir", inspect.Config.WorkingDir);
  if (inspect.Config?.User) args.push("--user", inspect.Config.User);
  args.push(targetImage);
  const cmd = inspect.Config?.Cmd;
  if (Array.isArray(cmd)) args.push(...cmd);
  return args;
}
