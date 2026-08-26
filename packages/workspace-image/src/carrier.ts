import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isJsonObject, requireDocker, runDocker, shellQuote } from "@atelier/core";
import { pruneSupersededWorkspaceImages, workspaceImageKindLabel } from "./prune.ts";

export const workspaceCarrierFormatVersion = 1;
export const workspaceCarrierStorageDriver = "fuse-overlayfs";
export const defaultAtelierWorkspaceImageSpecifier = "default-atelier-workspace-image";

export interface ResolvedDockerImagePreloadImage {
  spec: string;
  sourceRef: string;
  imageId: string;
  aliases: string[];
}

export interface ResolvedDockerImagePreload {
  refs: string[];
  images: ResolvedDockerImagePreloadImage[];
}

export interface WorkspaceImageCarrierResult {
  image: string;
  key: string;
  kind: "local hit" | "locally built";
}

interface CarrierLabels {
  [name: string]: string;
}

interface WorkspaceImageCarrierIdentity {
  image: string;
  key: string;
  labels: CarrierLabels;
}

const carrierTasks = new Map<string, Promise<WorkspaceImageCarrierResult>>();

function sortedUnique(values: string[]): string[] { return [...new Set(values)].sort(); }

function canonicalPreloadImages(preload: Pick<ResolvedDockerImagePreload, "images">): Array<{ ref: string; id: string; aliases: string[] }> {
  return preload.images
    .map((image) => ({ ref: image.sourceRef, id: image.imageId, aliases: sortedUnique(image.aliases) }))
    .sort((a, b) => a.ref.localeCompare(b.ref) || a.id.localeCompare(b.id));
}

export function workspaceCarrierKey(baseIdentity: string, platform: string, preload: Pick<ResolvedDockerImagePreload, "images">, version = workspaceCarrierFormatVersion): string {
  const hash = createHash("sha256");
  hash.update(`atelier-workspace-carrier-v${version}\0`);
  hash.update(platform); hash.update("\0");
  hash.update(workspaceCarrierStorageDriver); hash.update("\0");
  hash.update(baseIdentity); hash.update("\0");
  for (const image of canonicalPreloadImages(preload)) {
    hash.update(image.ref); hash.update("\0");
    hash.update(image.id); hash.update("\0");
    for (const alias of image.aliases) { hash.update(alias); hash.update("\0"); }
  }
  return hash.digest("hex").slice(0, 32);
}

async function dockerPlatform(ref: string): Promise<string> {
  const result = await requireDocker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref]);
  return result.stdout.trim();
}

export async function nativeLinuxDockerPlatform(): Promise<string | undefined> {
  const info = await requireDocker(["info", "--format", "{{.OperatingSystem}}|{{.OSType}}|{{.Architecture}}"]);
  const [operatingSystem, type, architectureValue] = info.stdout.trim().split("|");
  if (/docker desktop/i.test(operatingSystem ?? "")) return undefined;
  const architecture = architectureValue === "x86_64" ? "amd64" : architectureValue === "aarch64" ? "arm64" : architectureValue;
  return type === "linux" && architecture ? `linux/${architecture}` : undefined;
}

function carrierLabels(key: string, baseIdentity: string, platform: string, preload: ResolvedDockerImagePreload): CarrierLabels {
  return {
    "com.atelier.workspace-carrier.version": String(workspaceCarrierFormatVersion),
    "com.atelier.workspace-carrier.key": key,
    "com.atelier.workspace-carrier.base-image": baseIdentity,
    "com.atelier.workspace-carrier.storage-driver": workspaceCarrierStorageDriver,
    "com.atelier.workspace-carrier.platform": platform,
    "com.atelier.workspace-carrier.preload": JSON.stringify(canonicalPreloadImages(preload)),
  };
}

function carrierIdentity(options: { baseIdentity: string; platform: string; preload: ResolvedDockerImagePreload }): WorkspaceImageCarrierIdentity {
  const key = workspaceCarrierKey(options.baseIdentity, options.platform, options.preload);
  return {
    image: `atelier-workspace-carrier:${key}`,
    key,
    labels: carrierLabels(key, options.baseIdentity, options.platform, options.preload),
  };
}

async function validCarrier(ref: string, labels: Record<string, string>): Promise<boolean> {
  const result = await runDocker(["image", "inspect", "--format", "{{json .Config.Labels}}", ref]);
  if (result.exitCode !== 0) return false;
  const actual: unknown = JSON.parse(result.stdout.trim() || "{}");
  if (!isJsonObject(actual)) return false;
  return Object.entries(labels).every(([key, value]) => actual[key] === value);
}

async function findCarrier(identity: WorkspaceImageCarrierIdentity): Promise<string | undefined> {
  return await validCarrier(identity.image, identity.labels) ? identity.image : undefined;
}

export async function findWorkspaceImageCarrier(options: { baseIdentity: string; platform: string; preload: ResolvedDockerImagePreload }): Promise<string | undefined> {
  return await findCarrier(carrierIdentity(options));
}

export function nestedDockerDaemonInitScript(options: { logPath?: string; pidPath?: string } = {}): string {
  const logPath = options.logPath ?? "/.atelier/dockerd.log";
  const recordPid = options.pidPath ? `\necho $! > ${shellQuote(options.pidPath)}` : "";
  return `mkdir -p /.atelier /var/lib/docker
if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.sock
  nohup dockerd -H unix:///var/run/docker.sock --tls=false --storage-driver=fuse-overlayfs --max-concurrent-uploads=1 > ${shellQuote(logPath)} 2>&1 &${recordPid}
fi
for i in $(seq 1 300); do docker info >/dev/null 2>&1 && break; sleep .1; done
if ! docker info >/dev/null 2>&1; then tail -n 120 ${shellQuote(logPath)} >&2; exit 1; fi
storage_driver="$(docker info --format '{{.Driver}}')"
[ "$storage_driver" = fuse-overlayfs ] || { echo "unexpected nested Docker storage driver: $storage_driver" >&2; exit 1; }`;
}

const carrierDaemonPidPath = "/.atelier/carrier-dockerd.pid";
const carrierDaemonStartScript = nestedDockerDaemonInitScript({ logPath: "/.atelier/carrier-dockerd.log", pidPath: carrierDaemonPidPath });

async function exec(container: string, script: string): Promise<void> {
  await requireDocker(["exec", "--user", "root", container, "sh", "-lc", script]);
}

async function verifySeededImages(container: string, preload: ResolvedDockerImagePreload): Promise<void> {
  for (const ref of preload.refs) await exec(container, `docker image inspect ${shellQuote(ref)} >/dev/null`);
  for (const image of preload.images.filter((entry) => entry.spec === defaultAtelierWorkspaceImageSpecifier)) {
    await exec(container, `docker run --rm --entrypoint /bin/true ${shellQuote(image.sourceRef)}`);
  }
}

async function stopNestedDaemon(container: string): Promise<void> {
  await exec(container, `kill -TERM "$(cat ${carrierDaemonPidPath})"
for i in $(seq 1 300); do docker info >/dev/null 2>&1 || exit 0; sleep .1; done
echo "nested Docker daemon did not stop" >&2; exit 1`);
}

async function assertCarrierBase(baseImage: string, preload: ResolvedDockerImagePreload, platform: string): Promise<void> {
  const volumes = await requireDocker(["image", "inspect", "--format", "{{json .Config.Volumes}}", baseImage]);
  const parsed: unknown = JSON.parse(volumes.stdout.trim() || "null");
  if (parsed !== null && !isJsonObject(parsed)) throw new Error(`${baseImage} returned an invalid volume declaration`);
  if (parsed?.["/var/lib/docker"]) throw new Error(`${baseImage} declares /var/lib/docker as a volume`);
  if (await dockerPlatform(baseImage) !== platform) throw new Error(`workspace image platform does not match ${platform}`);
  for (const image of preload.images) if (await dockerPlatform(image.sourceRef) !== platform) throw new Error(`${image.sourceRef} platform does not match ${platform}`);
}

export async function buildWorkspaceImageCarrier(options: { baseImage: string; baseIdentity: string; platform: string; preload: ResolvedDockerImagePreload }): Promise<WorkspaceImageCarrierResult> {
  const { platform } = options;
  const identity = carrierIdentity(options);
  const { image: tag, key, labels } = identity;
  if (await findCarrier(identity)) return { image: tag, key, kind: "local hit" };
  const existing = carrierTasks.get(key);
  if (existing) return await existing;

  const task = (async (): Promise<WorkspaceImageCarrierResult> => {
    const buildStartedAt = new Date();
    await assertCarrierBase(options.baseImage, options.preload, platform);
    const suffix = crypto.randomUUID().slice(0, 8);
    const seed = `atelier-carrier-seed-${key.slice(0, 10)}-${suffix}`;
    const verify = `atelier-carrier-verify-${key.slice(0, 10)}-${suffix}`;
    const dir = join(tmpdir(), "atelier-carrier-builds", key);
    const tar = join(dir, "images.tar");
    const baseEntrypoint = (await requireDocker(["image", "inspect", "--format", "{{json .Config.Entrypoint}}", options.baseImage])).stdout.trim();
    try {
      await mkdir(dir, { recursive: true });
      await requireDocker(["save", "--output", tar, ...options.preload.refs]);
      await requireDocker(["create", "--name", seed, "--privileged", options.baseImage, "sh", "-lc", "sleep infinity"]);
      await requireDocker(["start", seed]);
      await exec(seed, "command -v dockerd >/dev/null && command -v fuse-overlayfs >/dev/null");
      await exec(seed, carrierDaemonStartScript);
      await requireDocker(["cp", tar, `${seed}:/.atelier/carrier-images.tar`]);
      await exec(seed, "docker load --input /.atelier/carrier-images.tar >/dev/null; rm -f /.atelier/carrier-images.tar");
      await verifySeededImages(seed, options.preload);
      await stopNestedDaemon(seed);
      await requireDocker(["stop", "--time", "30", seed]);
      const changes = Object.entries({ ...labels, [workspaceImageKindLabel]: "carrier" }).flatMap(([name, value]) => ["--change", `LABEL ${name}=${JSON.stringify(value)}`]);
      await requireDocker(["commit", ...changes, seed, tag]);
      const carrierEntrypoint = (await requireDocker(["image", "inspect", "--format", "{{json .Config.Entrypoint}}", tag])).stdout.trim();
      if (carrierEntrypoint !== baseEntrypoint) throw new Error("carrier commit changed the workspace image ENTRYPOINT");

      await requireDocker(["create", "--name", verify, "--privileged", tag, "sh", "-lc", "sleep infinity"]);
      await requireDocker(["start", verify]);
      await exec(verify, carrierDaemonStartScript);
      await verifySeededImages(verify, options.preload);
      await stopNestedDaemon(verify);
      pruneSupersededWorkspaceImages("carrier", buildStartedAt);
      return { image: tag, key, kind: "locally built" };
    } finally {
      await runDocker(["rm", "-f", verify]);
      await runDocker(["rm", "-f", seed]);
      await rm(dir, { recursive: true, force: true });
    }
  })().finally(() => carrierTasks.delete(key));
  carrierTasks.set(key, task);
  return await task;
}
