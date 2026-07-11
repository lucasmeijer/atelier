import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atelierDataPath, getAtelierRuntimeContext, requireDocker, runDocker, shellQuote } from "@atelier/core";

export const workspaceCarrierFormatVersion = 1;
export const workspaceCarrierStorageDriver = "fuse-overlayfs";

export interface ResolvedDockerImagePreloadImage {
  spec: string;
  sourceRef: string;
  imageId: string;
  aliases: string[];
}

export interface ResolvedDockerImagePreload {
  requestedSpecs: string[];
  refs: string[];
  images: ResolvedDockerImagePreloadImage[];
}

export interface WorkspaceImageCarrierResult {
  image: string;
  key: string;
  kind: "published hit" | "local hit" | "locally built";
}

export interface PublishedWorkspaceCarrier {
  platform: string;
  storageDriver: "fuse-overlayfs";
  sourceWorkspaceDockerfileHash: string;
  defaultWorkspaceImage: string;
  preloadSpecs: string[];
  image: string;
  key: string;
}

export interface PublishedWorkspaceCarriers {
  version: 1;
  carriers: PublishedWorkspaceCarrier[];
}

const carrierTasks = new Map<string, Promise<WorkspaceImageCarrierResult>>();
const carrierMetadataPath = join(dirname(fileURLToPath(import.meta.url)), "../../..", ".atelier-workspace-carriers.json");

function sortedUnique(values: string[]): string[] { return [...new Set(values)].sort(); }

export function repositoryWorkspaceDockerfileHash(contents: string): string {
  return createHash("sha256").update("atelier-repository-workspace-dockerfile-v1\n").update(contents).digest("hex");
}

export function logicalWorkspaceBaseIdentity(defaultImage: string, dockerfileContents: string): string {
  return `${defaultImage}@dockerfile-sha256:${repositoryWorkspaceDockerfileHash(dockerfileContents)}`;
}

export function workspaceCarrierKey(baseIdentity: string, platform: string, preload: Pick<ResolvedDockerImagePreload, "images">, version = workspaceCarrierFormatVersion): string {
  const hash = createHash("sha256");
  hash.update(`atelier-workspace-carrier-v${version}\0`);
  hash.update(platform); hash.update("\0");
  hash.update(workspaceCarrierStorageDriver); hash.update("\0");
  hash.update(baseIdentity); hash.update("\0");
  for (const image of [...preload.images].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef) || a.imageId.localeCompare(b.imageId))) {
    hash.update(image.sourceRef); hash.update("\0");
    hash.update(image.imageId); hash.update("\0");
    for (const alias of sortedUnique(image.aliases)) { hash.update(alias); hash.update("\0"); }
  }
  return hash.digest("hex").slice(0, 32);
}

export function parsePublishedWorkspaceCarriers(value: unknown): PublishedWorkspaceCarriers {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid workspace carrier metadata: expected object");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.carriers)) throw new Error("invalid workspace carrier metadata: unsupported version or carriers");
  const carriers = record.carriers.map((entry, index): PublishedWorkspaceCarrier => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid workspace carrier metadata: carriers[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    const strings = ["platform", "storageDriver", "sourceWorkspaceDockerfileHash", "defaultWorkspaceImage", "image", "key"] as const;
    for (const key of strings) if (typeof item[key] !== "string" || !(item[key] as string).trim()) throw new Error(`invalid workspace carrier metadata: carriers[${index}].${key}`);
    if (item.storageDriver !== workspaceCarrierStorageDriver) throw new Error(`invalid workspace carrier metadata: carriers[${index}].storageDriver`);
    if (!Array.isArray(item.preloadSpecs) || !item.preloadSpecs.every((spec) => typeof spec === "string" && spec.trim())) throw new Error(`invalid workspace carrier metadata: carriers[${index}].preloadSpecs`);
    return { platform: item.platform as string, storageDriver: workspaceCarrierStorageDriver, sourceWorkspaceDockerfileHash: item.sourceWorkspaceDockerfileHash as string, defaultWorkspaceImage: item.defaultWorkspaceImage as string, preloadSpecs: item.preloadSpecs as string[], image: item.image as string, key: item.key as string };
  });
  return { version: 1, carriers };
}

export async function readPublishedWorkspaceCarriers(): Promise<PublishedWorkspaceCarriers | undefined> {
  const file = Bun.file(carrierMetadataPath);
  if (!(await file.exists())) return undefined;
  return parsePublishedWorkspaceCarriers(JSON.parse(await file.text()));
}

export function selectPublishedWorkspaceCarrier(metadata: PublishedWorkspaceCarriers, input: { platform: string; defaultWorkspaceImage: string; dockerfileContents: string; preloadSpecs: string[] }): PublishedWorkspaceCarrier | undefined {
  const hash = repositoryWorkspaceDockerfileHash(input.dockerfileContents);
  const specs = sortedUnique(input.preloadSpecs);
  return metadata.carriers.find((carrier) => carrier.platform === input.platform
    && carrier.storageDriver === workspaceCarrierStorageDriver
    && carrier.defaultWorkspaceImage === input.defaultWorkspaceImage
    && carrier.sourceWorkspaceDockerfileHash === hash
    && JSON.stringify(sortedUnique(carrier.preloadSpecs)) === JSON.stringify(specs));
}

async function dockerPlatform(ref: string): Promise<string> {
  const result = await requireDocker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref]);
  return result.stdout.trim();
}

export async function nativeLinuxDockerPlatform(): Promise<string | undefined> {
  const info = await requireDocker(["info", "--format", "{{.OperatingSystem}}"]);
  if (/docker desktop/i.test(info.stdout)) return undefined;
  const os = await requireDocker(["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
  const [type, architectureValue] = os.stdout.trim().split("/");
  const architecture = architectureValue === "x86_64" ? "amd64" : architectureValue === "aarch64" ? "arm64" : architectureValue;
  return type === "linux" && architecture ? `linux/${architecture}` : undefined;
}

function carrierLabels(key: string, baseIdentity: string, platform: string, preload: ResolvedDockerImagePreload): Record<string, string> {
  return {
    "com.atelier.workspace-carrier.version": String(workspaceCarrierFormatVersion),
    "com.atelier.workspace-carrier.key": key,
    "com.atelier.workspace-carrier.base-image": baseIdentity,
    "com.atelier.workspace-carrier.storage-driver": workspaceCarrierStorageDriver,
    "com.atelier.workspace-carrier.platform": platform,
    "com.atelier.workspace-carrier.preload": JSON.stringify(preload.images.map((image) => ({ ref: image.sourceRef, id: image.imageId, aliases: sortedUnique(image.aliases) }))),
  };
}

async function validCarrier(ref: string, labels: Record<string, string>): Promise<boolean> {
  const result = await runDocker(["image", "inspect", "--format", "{{json .Config.Labels}}", ref]);
  if (result.exitCode !== 0) return false;
  const actual = JSON.parse(result.stdout.trim() || "{}") as Record<string, string>;
  return Object.entries(labels).every(([key, value]) => actual[key] === value);
}

function publishedCarrierAbsent(result: { stdout: string; stderr: string }): boolean {
  return /manifest unknown|not found|no matching manifest/i.test(`${result.stderr}\n${result.stdout}`);
}

export async function resolvePublishedWorkspaceImageCarrier(options: { published: PublishedWorkspaceCarrier; baseIdentity: string; platform: string; preload: ResolvedDockerImagePreload }): Promise<WorkspaceImageCarrierResult | undefined> {
  const key = workspaceCarrierKey(options.baseIdentity, options.platform, options.preload);
  if (options.published.key !== key) return undefined;
  const labels = carrierLabels(key, options.baseIdentity, options.platform, options.preload);
  if (!await validCarrier(options.published.image, labels)) {
    const pull = await runDocker(["pull", options.published.image]);
    if (pull.exitCode !== 0) {
      if (publishedCarrierAbsent(pull)) return undefined;
      throw new Error(pull.stderr.trim() || `docker pull ${options.published.image} failed`);
    }
    if (!await validCarrier(options.published.image, labels)) throw new Error(`published workspace carrier ${options.published.image} has incompatible labels`);
  }
  return { image: options.published.image, key, kind: "published hit" };
}

export function nestedDockerDaemonInitScript(options: { logPath?: string; pidPath?: string } = {}): string {
  const logPath = options.logPath ?? "/.atelier/dockerd.log";
  const recordPid = options.pidPath ? `\necho $! > ${shellQuote(options.pidPath)}` : "";
  return `mkdir -p /.atelier /var/lib/docker
if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.sock
  nohup dockerd -H unix:///var/run/docker.sock --tls=false --storage-driver=fuse-overlayfs > ${shellQuote(logPath)} 2>&1 &${recordPid}
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

async function verifySeededImages(container: string, preload: ResolvedDockerImagePreload, executeMagic: boolean): Promise<void> {
  for (const ref of preload.refs) await exec(container, `docker image inspect ${shellQuote(ref)} >/dev/null`);
  if (executeMagic) {
    for (const image of preload.images.filter((entry) => entry.spec === "atelier-default-workspace")) {
      await exec(container, `docker run --rm --entrypoint /bin/true ${shellQuote(image.sourceRef)}`);
    }
  }
}

async function stopNestedDaemon(container: string): Promise<void> {
  await exec(container, `kill -TERM "$(cat ${carrierDaemonPidPath})"
for i in $(seq 1 300); do docker info >/dev/null 2>&1 || exit 0; sleep .1; done
echo "nested Docker daemon did not stop" >&2; exit 1`);
}

async function assertCarrierBase(baseImage: string, preload: ResolvedDockerImagePreload, platform: string): Promise<void> {
  const volumes = await requireDocker(["image", "inspect", "--format", "{{json .Config.Volumes}}", baseImage]);
  const parsed = JSON.parse(volumes.stdout.trim() || "null") as Record<string, unknown> | null;
  if (parsed?.["/var/lib/docker"]) throw new Error(`${baseImage} declares /var/lib/docker as a volume`);
  if (await dockerPlatform(baseImage) !== platform) throw new Error(`workspace image platform does not match ${platform}`);
  for (const image of preload.images) if (await dockerPlatform(image.sourceRef) !== platform) throw new Error(`${image.sourceRef} platform does not match ${platform}`);
}

export async function buildWorkspaceImageCarrier(options: { baseImage: string; baseIdentity: string; preload: ResolvedDockerImagePreload }): Promise<WorkspaceImageCarrierResult> {
  const platform = await nativeLinuxDockerPlatform();
  if (!platform) throw new Error("workspace image carriers require a native Linux Docker Engine");
  const key = workspaceCarrierKey(options.baseIdentity, platform, options.preload);
  const labels = carrierLabels(key, options.baseIdentity, platform, options.preload);

  const tag = `atelier-workspace-carrier:${key}`;
  if (await validCarrier(tag, labels)) return { image: tag, key, kind: "local hit" };
  const existing = carrierTasks.get(key);
  if (existing) return await existing;

  const task = (async (): Promise<WorkspaceImageCarrierResult> => {
    await assertCarrierBase(options.baseImage, options.preload, platform);
    const suffix = crypto.randomUUID().slice(0, 8);
    const seed = `atelier-carrier-seed-${key.slice(0, 10)}-${suffix}`;
    const verify = `atelier-carrier-verify-${key.slice(0, 10)}-${suffix}`;
    const dir = atelierDataPath(getAtelierRuntimeContext(), "carrier-builds", key);
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
      await verifySeededImages(seed, options.preload, true);
      await stopNestedDaemon(seed);
      await requireDocker(["stop", "--time", "30", seed]);
      const changes = Object.entries(labels).flatMap(([name, value]) => ["--change", `LABEL ${name}=${JSON.stringify(value)}`]);
      await requireDocker(["commit", ...changes, seed, tag]);
      const carrierEntrypoint = (await requireDocker(["image", "inspect", "--format", "{{json .Config.Entrypoint}}", tag])).stdout.trim();
      if (carrierEntrypoint !== baseEntrypoint) throw new Error("carrier commit changed the workspace image ENTRYPOINT");

      await requireDocker(["create", "--name", verify, "--privileged", tag, "sh", "-lc", "sleep infinity"]);
      await requireDocker(["start", verify]);
      await exec(verify, carrierDaemonStartScript);
      await verifySeededImages(verify, options.preload, true);
      await stopNestedDaemon(verify);
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
