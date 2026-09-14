import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { hostname } from "node:os";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

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

const labelsSchema = Type.Record(Type.String(), Type.String());
const imageSchema = Type.Object({
  Id: Type.String(), RepoDigests: Type.Optional(Type.Array(Type.String())),
  Config: Type.Optional(Type.Object({ Labels: Type.Optional(Type.Union([labelsSchema, Type.Null()])) })),
});
export type DockerImage = Static<typeof imageSchema>;
export async function dockerImageInspect(reference: string, exec: DockerExec = dockerExec): Promise<DockerImage> {
  const result = await exec(["image", "inspect", reference]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Image is unavailable: ${reference}`);
  const image = Value.Parse(Type.Array(imageSchema), JSON.parse(result.stdout))[0];
  if (!image) throw new Error(`Docker returned no image: ${reference}`);
  return image;
}
export interface SelfUpdateRuntime { currentRevision?: string; currentDigest: string; }
/** Only System's managed app can ask its supervisor to replace it. */
export async function detectSelfUpdateRuntime(exec: DockerExec = dockerExec, containerId = ownContainerId): Promise<SelfUpdateRuntime | undefined> {
  const id = await containerId();
  if (!id) return undefined;
  const result = await exec(["inspect", id]);
  if (result.code !== 0) return undefined;
  const container = Value.Parse(Type.Array(Type.Object({ Image: Type.String(), Config: Type.Object({ Labels: Type.Optional(Type.Union([labelsSchema, Type.Null()])) }) })), JSON.parse(result.stdout))[0];
  if (container?.Config.Labels?.["atelier.role"] !== "app") return undefined;
  const image = await dockerImageInspect(container.Image, exec);
  return { currentRevision: image.Config?.Labels?.["org.opencontainers.image.revision"], currentDigest: image.RepoDigests?.find((ref) => ref.startsWith("ghcr.io/lucasmeijer/atelier@"))?.split("@")[1] ?? image.Id };
}
export interface PreparedUpdate { imageId: string; reference: string; }
export async function prepareUpdate(reference: string, progress: (progress: PullProgress) => void, deps: {
  pull?: typeof pullImageReference; inspect?: typeof dockerImageInspect;
} = {}): Promise<PreparedUpdate> {
  const pull = deps.pull ?? pullImageReference;
  const inspect = deps.inspect ?? dockerImageInspect;
  await pull(reference, (event) => progress({ ...event, percent: event.percent === undefined ? undefined : Math.floor(event.percent / 2), message: "Downloading Atelier" }));
  const image = await inspect(reference);
  const dependencies = Value.Parse(Type.Array(Type.String({ minLength: 1 })), JSON.parse(image.Config?.Labels?.["eagerly-preload"] ?? "[]"));
  for (const dependency of dependencies) {
    if (dependency.startsWith("-") || /\s/.test(dependency)) throw new Error(`Invalid eagerly-preload image: ${dependency}`);
  }
  const images = [...new Set(dependencies)];
  progress({ kind: "progress", percent: images.length ? 50 : 100, message: "Atelier downloaded" });
  for (const [index, dependency] of images.entries()) {
    await pull(dependency, (event) => progress({ ...event, percent: event.percent === undefined ? undefined : Math.min(99, 50 + Math.floor((index * 50 + event.percent / 2) / images.length)), message: `Downloading workspace image ${index + 1} of ${images.length}` }));
    await inspect(dependency);
  }
  progress({ kind: "progress", percent: 100 });
  return { imageId: image.Id, reference };
}

export interface PullProgress { kind: "progress"; percent?: number; message?: string }

const dockerPullEventSchema = Type.Object({
  id: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  progressDetail: Type.Optional(Type.Object({
    current: Type.Optional(Type.Number()),
    total: Type.Optional(Type.Number()),
  })),
  error: Type.Optional(Type.String()),
});

export type DockerPullEvent = Static<typeof dockerPullEventSchema>;
type PullLayer = { current: number; total: number };

export function parseDockerPullEventLine(line: string): DockerPullEvent {
  return Value.Parse(dockerPullEventSchema, JSON.parse(line));
}

function dockerApiImageCreatePath(reference: string): string {
  return `/images/create?${new URLSearchParams({ fromImage: reference }).toString()}`;
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
  const event = parseDockerPullEventLine(line);
  if (event.error) throw new Error(event.error);
  if (event.id && event.progressDetail?.total) layers.set(event.id, { current: event.progressDetail.current ?? 0, total: event.progressDetail.total });
  if (event.id && (event.status === "Pull complete" || event.status === "Already exists") && layers.has(event.id)) {
    const layer = layers.get(event.id)!;
    layers.set(event.id, { current: layer.total, total: layer.total });
  }
  return { kind: "progress", percent: pullPercent(layers), message: event.status };
}

export async function pullImageReference(reference: string, onProgress: (progress: PullProgress) => void, socketPath = "/var/run/docker.sock"): Promise<void> {
  const layers = new Map<string, PullLayer>();
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, path: dockerApiImageCreatePath(reference), method: "POST" }, (res) => {
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
        try { for (const line of lines) emitLine(line); } catch (error) { req.destroy(); reject(error); }
      });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) reject(new Error(errorBody.trim() || `Docker image create failed with HTTP ${res.statusCode}`));
        else {
          try { emitLine(buffer); resolve(); } catch (error) { reject(error); }
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  onProgress({ kind: "progress", percent: 100 });
}
