import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDocker, runDocker, shellQuote, type AtelierEventBus } from "@atelier/core";
import { runHostObservableCommand, tailTerminalText } from "@atelier/observable-terminal/server";
import { buildWorkspaceImageCarrier, defaultAtelierWorkspaceImageSpecifier, findWorkspaceImageCarrier, nativeLinuxDockerPlatform, type ResolvedDockerImagePreload } from "./carrier.ts";
import { parseWorkspaceImageMetadata, type WorkspaceImageMetadata } from "./metadata.ts";
import { pruneSupersededWorkspaceImages, workspaceImageKindLabel, type WorkspaceImageKind } from "./prune.ts";
import { dockerImageStoreQueue, workspaceImageStoreWaitReporter } from "./image-store-queue.ts";
import { readDockerRuntimeConnection } from "./runtime-connection.ts";
import { buildSharedWorkspaceImage, sharedWorkspaceImageTag, type SharedWorkspaceBuild } from "./shared-build.ts";
import { dockerServerPlatform, nativeImageExists as imageExists } from "./local-images.ts";

export * from "./carrier.ts";
export * from "./runtime-connection.ts";
export { prepareSharedImagePreload } from "./shared-preload.ts";
export { readSharedLayerStorage, type SharedLayerStorage } from "./storage.ts";

type BuiltWorkspaceImageKind = Exclude<WorkspaceImageKind, "carrier">;

interface WorkspaceImageBuildTask {
  tag: string;
  modules: string[];
  output: string;
  session?: string;
  promise: Promise<void>;
}

interface DefaultWorkspaceImageDescriptor {
  image: string;
  build?: { contextDir: string; metadata: WorkspaceImageMetadata };
}

export interface ResolveWorkspaceImageOptions {
  workspaceId?: string;
  events?: AtelierEventBus;
  sourcePath?: string;
  dockerfile?: string;
  buildOutput?: "inherit";
}

export interface WorkspaceImageResolution {
  image: string;
  defaultImage: string;
}

export interface WorkspaceImageCarrierResolution {
  image: string;
  key: string;
  path: "local hit" | "locally built";
  initScripts: string[];
}

const maxBuildOutputBytes = 64 * 1024;
const buildTasks = new Map<string, WorkspaceImageBuildTask>();
const defaultImageRefFile = join(repoRoot(), ".atelier-default-workspace-image");

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function namespaceSlug(): string {
  return (process.env.ATELIER_NAMESPACE || "host").replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}

function contextBaseDir(): string {
  return join("/tmp", "atelier-workspace-image-context", namespaceSlug());
}

function defaultContextDir(): string {
  return join(contextBaseDir(), "default");
}

async function contextMetadata(contextDir: string): Promise<WorkspaceImageMetadata> {
  const path = join(contextDir, "metadata.json");
  return parseWorkspaceImageMetadata(JSON.parse(await readFile(path, "utf8")));
}

async function pullImage(tag: string, options: ResolveWorkspaceImageOptions): Promise<void> {
  if (await imageExists(tag)) return;
  const platform = await dockerServerPlatform();
  const result = await dockerImageStoreQueue.run({
    label: `Pulling workspace image ${tag}`,
    onWait: workspaceImageStoreWaitReporter({ events: options.events, workspaceId: options.workspaceId, parentId: "workspace.image" }),
  }, () => runDocker(["pull", "--platform", platform, tag]));
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `docker pull ${tag} failed`);
}

function appendOutput(task: WorkspaceImageBuildTask, chunk: string): void {
  task.output = `${task.output}${chunk}`;
  if (task.output.length > maxBuildOutputBytes) task.output = task.output.slice(-maxBuildOutputBytes);
}

function imageDetail(task: Pick<WorkspaceImageBuildTask, "tag" | "modules">): string {
  return `Image: ${task.tag}${task.modules.length ? ` · Modules: ${task.modules.join(", ")}` : ""}`;
}

async function emitImageStep(events: AtelierEventBus | undefined, workspaceId: string | undefined, task: WorkspaceImageBuildTask, status: "running" | "done" | "failed", error?: string): Promise<void> {
  if (!events || !workspaceId) return;
  const event = {
    workspaceId,
    id: "workspace.image",
    label: "Resolve workspace image",
    status,
    detail: imageDetail(task),
    output: tailTerminalText(task.output),
    error,
  };
  if (task.session) Object.assign(event, { terminal: { kind: "host-tmux" as const, session: task.session } });
  await events.emit("workspace_provision_step", event);
}

function dockerBuildArgs(tag: string, kind: BuiltWorkspaceImageKind, dockerfile: string, contextDir: string, options: ResolveWorkspaceImageOptions): string[] {
  return [
    "build",
    ...(options.buildOutput === "inherit" ? ["--progress=plain"] : []),
    ...(process.env.ATELIER_WORKSPACE_IMAGE_NO_CACHE === "1" ? ["--no-cache"] : []),
    "--label", `${workspaceImageKindLabel}=${kind}`,
    "-t", tag,
    "-f", dockerfile,
    contextDir,
  ];
}

function startBuildTask(tag: string, modules: string[], kind: BuiltWorkspaceImageKind, dockerfile: string, contextDir: string, options: ResolveWorkspaceImageOptions): WorkspaceImageBuildTask {
  const existing = buildTasks.get(tag);
  if (existing) return existing;

  const task: WorkspaceImageBuildTask = { tag, modules, output: "", promise: Promise.resolve() };
  task.promise = dockerImageStoreQueue.run({
    label: `Building workspace image ${tag}`,
    onWait: workspaceImageStoreWaitReporter({ events: options.events, workspaceId: options.workspaceId, parentId: "workspace.image" }),
  }, async () => {
    const buildStartedAt = new Date();
    const args = dockerBuildArgs(tag, kind, dockerfile, contextDir, options);
    if (options.buildOutput === "inherit") {
      const proc = Bun.spawn(["docker", ...args], { cwd: contextDir, env: { ...process.env, DOCKER_BUILDKIT: "1" }, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) throw new Error(`docker build failed with exit code ${exitCode}`);
    } else {
      const result = await runHostObservableCommand({
        session: `atelier-provision-image-${crypto.randomUUID().slice(0, 8)}`,
        cwd: contextDir,
        command: `echo "Starting Docker image build..."\nDOCKER_BUILDKIT=1 docker ${args.map(shellQuote).join(" ")}`,
        onSessionStarted: async (session) => {
          task.session = session;
          await emitImageStep(options.events, options.workspaceId, task, "running");
        },
      });
      appendOutput(task, result.output);
      if (result.exitCode !== 0) throw new Error(`docker build failed with exit code ${result.exitCode}`);
    }
    pruneSupersededWorkspaceImages(kind, buildStartedAt);
  }).finally(() => {
    buildTasks.delete(tag);
  });

  buildTasks.set(tag, task);
  return task;
}

async function waitForBuildTask(task: WorkspaceImageBuildTask, options: ResolveWorkspaceImageOptions): Promise<void> {
  await emitImageStep(options.events, options.workspaceId, task, "running");
  try {
    await task.promise;
    await emitImageStep(options.events, options.workspaceId, task, "done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitImageStep(options.events, options.workspaceId, task, "failed", message);
    throw new Error(`${message}\n\n${tailTerminalText(task.output)}`.trim());
  }
}

async function runSharedImageBuild(build: SharedWorkspaceBuild, metadata: WorkspaceImageMetadata, options: ResolveWorkspaceImageOptions): Promise<string> {
  const task: WorkspaceImageBuildTask = { tag: metadata.tag, modules: metadata.modules, output: "", promise: Promise.resolve() };
  await emitImageStep(options.events, options.workspaceId, task, "running");
  try {
    const image = await dockerImageStoreQueue.run({ label: `Building workspace image ${metadata.tag}`, onWait: workspaceImageStoreWaitReporter({ events: options.events, workspaceId: options.workspaceId, parentId: "workspace.image" }) }, () => buildSharedWorkspaceImage({
      ...build, noCache: process.env.ATELIER_WORKSPACE_IMAGE_NO_CACHE === "1",
      onOutput: async (chunk) => { appendOutput(task, chunk); if (options.buildOutput === "inherit") process.stderr.write(chunk); await emitImageStep(options.events, options.workspaceId, task, "running"); },
    }));
    await emitImageStep(options.events, options.workspaceId, task, "done");
    return image;
  } catch (error) {
    await emitImageStep(options.events, options.workspaceId, task, "failed", String(error));
    throw error;
  }
}

function generateContext(contextDir: string): void {
  const root = repoRoot();
  const script = join(root, "packages/workspace-image/scripts/build-context.mjs");
  if (!existsSync(script)) throw new Error(`workspace image context generator not found: ${script}`);
  const generated = Bun.spawnSync(["bun", script, contextDir], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (generated.exitCode !== 0) throw new Error(`could not generate workspace image context: ${generated.stderr.toString() || generated.stdout.toString()}`);
}

async function bakedDefaultWorkspaceImageRef(): Promise<string | undefined> {
  const file = Bun.file(defaultImageRefFile);
  if (!(await file.exists())) return undefined;
  const ref = (await file.text()).trim();
  return ref || undefined;
}

let defaultWorkspaceImageDescriptorPromise: Promise<DefaultWorkspaceImageDescriptor> | undefined;

async function describeDefaultWorkspaceImage(): Promise<DefaultWorkspaceImageDescriptor> {
  const baked = await bakedDefaultWorkspaceImageRef();
  if (baked) return { image: baked };

  const contextDir = defaultContextDir();
  generateContext(contextDir);
  const metadata = await contextMetadata(contextDir);
  return { image: metadata.tag, build: { contextDir, metadata } };
}

function defaultWorkspaceImageDescriptor(): Promise<DefaultWorkspaceImageDescriptor> {
  defaultWorkspaceImageDescriptorPromise ??= describeDefaultWorkspaceImage().catch((error) => {
    defaultWorkspaceImageDescriptorPromise = undefined;
    throw error;
  });
  return defaultWorkspaceImageDescriptorPromise;
}

async function inspectDefaultWorkspaceImage(): Promise<string | undefined> {
  const { image } = await defaultWorkspaceImageDescriptor();
  return await imageExists(image) ? image : undefined;
}

async function ensureBuiltImage(contextDir: string, dockerfile: string, metadata: WorkspaceImageMetadata, kind: BuiltWorkspaceImageKind, options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  if (process.env.ATELIER_WORKSPACE_IMAGE_NO_CACHE !== "1" && await imageExists(metadata.tag)) return metadata.tag;
  const task = startBuildTask(metadata.tag, metadata.modules, kind, dockerfile, contextDir, options);
  await waitForBuildTask(task, options);
  return metadata.tag;
}

let defaultWorkspaceImagePromise: Promise<string> | undefined;

async function resolveDefaultWorkspaceImage(options: ResolveWorkspaceImageOptions): Promise<string> {
  const descriptor = await defaultWorkspaceImageDescriptor();
  if (!descriptor.build) {
    await pullImage(descriptor.image, options);
    return descriptor.image;
  }
  // Generated defaults are content-tagged. Both the dev launcher and its server
  // must reuse a preloaded tag instead of independently solving the same image.
  if (process.env.ATELIER_WORKSPACE_IMAGE_NO_CACHE !== "1" && await imageExists(descriptor.image)) return descriptor.image;
  const connection = await readDockerRuntimeConnection();
  if (connection?.buildServices) {
    const { contextDir, metadata } = descriptor.build;
    const dockerfile = join(contextDir, "Dockerfile");
    await runSharedImageBuild({ kind: "default", connection, sourcePath: contextDir, dockerfile, originalDockerfile: dockerfile, tag: metadata.tag }, metadata, options);
    // Preserve the generated content tag used by default-image aliases and builds.
    return descriptor.image;
  }
  return await ensureBuiltImage(descriptor.build.contextDir, join(descriptor.build.contextDir, "Dockerfile"), descriptor.build.metadata, "default", options);
}

export function ensureDefaultWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  defaultWorkspaceImagePromise ??= resolveDefaultWorkspaceImage(options).catch((error) => {
    defaultWorkspaceImagePromise = undefined;
    throw error;
  });
  return defaultWorkspaceImagePromise;
}

async function assertWorkspaceDockerfileBase(dockerfile: string): Promise<void> {
  const firstLine = (await readFile(dockerfile, "utf8")).split("\n")[0].trim();
  if (firstLine !== "FROM atelier-workspace") throw new Error(`${dockerfile} must start with FROM atelier-workspace`);
}

function splitDockerfileInstructions(dockerfile: string): string[] {
  const instructions: string[] = [];
  let current = "";
  for (const line of dockerfile.split("\n")) {
    current = current ? `${current}\n${line}` : line;
    if (!line.trimEnd().endsWith("\\")) {
      instructions.push(current);
      current = "";
    }
  }
  if (current) instructions.push(current);
  return instructions;
}

function removeAptListCleanup(instruction: string): string {
  return instruction
    .replaceAll(/\\\n\s*&&\s*rm\s+-rf\s+\/var\/lib\/apt\/lists\/\*\s*/g, "")
    .replaceAll(/\s*&&\s*rm\s+-rf\s+\/var\/lib\/apt\/lists\/\*/g, "");
}

interface AptCacheMountResult {
  instruction: string;
  changed: boolean;
}

function addAptCacheMount(instruction: string): AptCacheMountResult {
  const cleaned = removeAptListCleanup(instruction);
  const next = cleaned.replace(/^(\s*)RUN\s+apt-get\s+update\b/, "$1RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n    apt-get update");
  return { instruction: next, changed: next !== cleaned || cleaned !== instruction };
}

async function optimizedRepoDockerfile(sourcePath: string, dockerfile: string): Promise<string> {
  const source = await readFile(dockerfile, "utf8");
  const instructions = splitDockerfileInstructions(source);
  let changed = false;
  const optimized = instructions.map((instruction) => {
    const result = addAptCacheMount(instruction);
    changed ||= result.changed;
    return result.instruction;
  });
  if (!changed) return dockerfile;

  optimized.splice(1, 0, "RUN rm -f /etc/apt/apt.conf.d/docker-clean \\\n && printf '%s\\n' 'Binary::apt::APT::Keep-Downloaded-Packages \"true\";' > /etc/apt/apt.conf.d/keep-cache");
  const generatedDir = join(contextBaseDir(), "repo-dockerfiles");
  await mkdir(generatedDir, { recursive: true });
  const generated = join(generatedDir, `${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}.Dockerfile`);
  await writeFile(generated, `# syntax=docker/dockerfile:1\n${optimized.join("\n")}\n`);
  return generated;
}

export function repositoryWorkspaceImageTag(baseImage: string, dockerfileContents: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update("atelier-repo-workspace-dockerfile-v5\n");
  hash.update(baseImage); hash.update("\0");
  hash.update(dockerfileContents); hash.update("\0");
  return `atelier-workspace:${hash.digest("hex").slice(0, 16)}`;
}

async function repoWorkspaceImageMetadata(dockerfile: string, baseImage: string): Promise<WorkspaceImageMetadata> {
  await assertWorkspaceDockerfileBase(dockerfile);
  return { tag: repositoryWorkspaceImageTag(baseImage, await readFile(dockerfile)), modules: ["repo"] };
}

async function tagAtelierWorkspaceBase(baseImage: string): Promise<void> {
  const result = await dockerImageStoreQueue.run({ label: "Tagging the workspace base image" }, () => runDocker(["tag", baseImage, "atelier-workspace"]));
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `docker tag ${baseImage} atelier-workspace failed`);
}

function uniqueStrings(values: string[]): string[] { return [...new Set(values)]; }

function normalizedPreloadSpecs(specs: string[]): string[] {
  return uniqueStrings(specs.map((spec) => {
    const trimmed = spec.trim();
    if (!trimmed) throw new Error("Docker image preload specs must be non-empty strings");
    return trimmed;
  }));
}

function mergeResolvedPreloadImages(images: ResolvedDockerImagePreload["images"]): ResolvedDockerImagePreload {
  const merged = new Map<string, ResolvedDockerImagePreload["images"][number]>();
  for (const image of images) {
    const key = `${image.sourceRef}\0${image.imageId}`;
    const existing = merged.get(key);
    if (!existing) merged.set(key, image);
    else {
      existing.aliases = uniqueStrings([...existing.aliases, ...image.aliases]);
      if (image.spec === defaultAtelierWorkspaceImageSpecifier) existing.spec = image.spec;
    }
  }
  const resolvedImages = [...merged.values()];
  return { refs: uniqueStrings(resolvedImages.flatMap((image) => [image.sourceRef, ...image.aliases])), images: resolvedImages };
}

export async function dockerImageId(ref: string): Promise<string> {
  const inspected = await requireDocker(["image", "inspect", "--format", "{{.Id}}", ref]);
  return inspected.stdout.trim();
}

function dockerRefTag(ref: string): string | undefined {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(colon + 1) : undefined;
}

export function defaultWorkspaceImageLocalAlias(defaultImage: string): string | undefined {
  const tag = dockerRefTag(defaultImage);
  return tag && /^[a-f0-9]{16}$/.test(tag) ? `atelier-workspace:${tag}` : undefined;
}

async function ensureOuterImage(ref: string, options: Pick<ResolveWorkspaceImageOptions, "events" | "workspaceId">): Promise<void> {
  if (await imageExists(ref)) return;
  const platform = await dockerServerPlatform();
  const pulled = await dockerImageStoreQueue.run({
    label: `Pulling nested Docker image ${ref}`,
    onWait: workspaceImageStoreWaitReporter({ events: options.events, workspaceId: options.workspaceId, parentId: "workspace.docker-images" }),
  }, () => runDocker(["pull", "--platform", platform, ref]));
  if (pulled.exitCode !== 0) throw new Error(pulled.stderr.trim() || `docker pull ${ref} failed`);
}

interface DockerImagePreloadOptions { specs: string[]; workspaceResolution: WorkspaceImageResolution; events?: AtelierEventBus; workspaceId?: string }

async function dockerImagePreload(options: DockerImagePreloadOptions, mode: "materialize"): Promise<ResolvedDockerImagePreload>;
async function dockerImagePreload(options: DockerImagePreloadOptions, mode: "inspect"): Promise<ResolvedDockerImagePreload | undefined>;
async function dockerImagePreload(options: DockerImagePreloadOptions, mode: "materialize" | "inspect"): Promise<ResolvedDockerImagePreload | undefined> {
  const specs = normalizedPreloadSpecs(options.specs);
  const images: ResolvedDockerImagePreload["images"] = [];
  for (const spec of specs) {
    const sourceRef = spec === defaultAtelierWorkspaceImageSpecifier ? options.workspaceResolution.defaultImage : spec;
    if (mode === "materialize") await ensureOuterImage(sourceRef, options);
    else if (!await imageExists(sourceRef)) return undefined;
    const aliases: string[] = [];
    if (spec === defaultAtelierWorkspaceImageSpecifier) {
      const alias = defaultWorkspaceImageLocalAlias(sourceRef);
      if (alias && alias !== sourceRef) {
        if (mode === "materialize") await requireDocker(["tag", sourceRef, alias]);
        aliases.push(alias);
      }
    }
    images.push({ spec, sourceRef, imageId: await dockerImageId(sourceRef), aliases });
  }
  return mergeResolvedPreloadImages(images);
}

export async function resolveDockerImagePreload(options: DockerImagePreloadOptions): Promise<ResolvedDockerImagePreload> {
  return await dockerImagePreload(options, "materialize");
}

async function inspectDockerImagePreload(options: DockerImagePreloadOptions): Promise<ResolvedDockerImagePreload | undefined> {
  return await dockerImagePreload(options, "inspect");
}

export function dockerImagePreloadVerificationInitScript(refs: string[]): string {
  const quoted = refs.map(shellQuote).join(" ");
  return `for ref in ${quoted}; do docker image inspect "$ref" >/dev/null || { echo "preloaded Docker image is missing: $ref" >&2; exit 1; }; done`;
}

export async function prepareWorkspaceImageCarrier(options: { resolution: WorkspaceImageResolution; platform: string; preload: ResolvedDockerImagePreload; events?: AtelierEventBus; workspaceId?: string; onProgress?: (message: string) => void | Promise<void> }): Promise<WorkspaceImageCarrierResolution> {
  const carrier = await buildWorkspaceImageCarrier({ baseImage: options.resolution.image, baseIdentity: await dockerImageId(options.resolution.image), platform: options.platform, preload: options.preload, events: options.events, workspaceId: options.workspaceId, onProgress: options.onProgress });
  return { image: carrier.image, key: carrier.key, path: carrier.kind, initScripts: [dockerImagePreloadVerificationInitScript(options.preload.refs)] };
}

export async function workspaceDockerfile(sourcePath: string, override?: string): Promise<string> {
  if (!override?.trim()) return join(sourcePath, ".atelier", "Dockerfile");
  const dir = join(contextBaseDir(), "project-dockerfiles");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${createHash("sha256").update(override).digest("hex")}.Dockerfile`);
  await writeFile(path, override);
  return path;
}

async function inspectWorkspaceImageResolution(options: Pick<ResolveWorkspaceImageOptions, "sourcePath" | "dockerfile"> = {}): Promise<WorkspaceImageResolution | undefined> {
  const baseImage = await inspectDefaultWorkspaceImage();
  if (!baseImage) return undefined;
  if (!options.sourcePath) return { image: baseImage, defaultImage: baseImage };

  const dockerfile = await workspaceDockerfile(options.sourcePath, options.dockerfile);
  if (!(await Bun.file(dockerfile).exists())) return { image: baseImage, defaultImage: baseImage };

  const metadata = await repoWorkspaceImageMetadata(dockerfile, baseImage);
  if ((await readDockerRuntimeConnection())?.buildServices) metadata.tag = sharedWorkspaceImageTag(metadata.tag, options.sourcePath);
  return await imageExists(metadata.tag) ? { image: metadata.tag, defaultImage: baseImage } : undefined;
}

export async function inspectWorkspaceImage(options: { sourcePath?: string; dockerfile?: string; preloadImages?: string[] } = {}): Promise<string | undefined> {
  const resolution = await inspectWorkspaceImageResolution(options);
  if (!resolution) return undefined;
  if (!options.preloadImages?.length) return await dockerImageId(resolution.image);

  const platform = await nativeLinuxDockerPlatform();
  if (!platform) return await dockerImageId(resolution.image);
  const preload = await inspectDockerImagePreload({ specs: options.preloadImages, workspaceResolution: resolution });
  if (!preload) return undefined;
  const carrier = await findWorkspaceImageCarrier({ baseIdentity: await dockerImageId(resolution.image), platform, preload });
  return carrier ? await dockerImageId(carrier) : undefined;
}

export async function resolveWorkspaceImageResolution(options: ResolveWorkspaceImageOptions = {}): Promise<WorkspaceImageResolution> {
  const baseImage = await ensureDefaultWorkspaceImage();
  if (!options.sourcePath) return { image: baseImage, defaultImage: baseImage };

  const dockerfile = await workspaceDockerfile(options.sourcePath, options.dockerfile);
  if (!(await Bun.file(dockerfile).exists())) return { image: baseImage, defaultImage: baseImage };

  const metadata = await repoWorkspaceImageMetadata(dockerfile, baseImage);
  const buildDockerfile = await optimizedRepoDockerfile(options.sourcePath, dockerfile);
  const connection = await readDockerRuntimeConnection();
  if (connection?.buildServices) {
    const sourcePath = options.sourcePath;
    metadata.tag = sharedWorkspaceImageTag(metadata.tag, sourcePath);
    const image = await runSharedImageBuild({ kind: "repository", connection, sourcePath, dockerfile: buildDockerfile, originalDockerfile: dockerfile, baseImage, tag: metadata.tag }, metadata, options);
    return { image, defaultImage: baseImage };
  }
  await tagAtelierWorkspaceBase(baseImage);
  const image = await ensureBuiltImage(options.sourcePath, buildDockerfile, metadata, "repository", options);
  return { image, defaultImage: baseImage };
}

export async function resolveWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  return (await resolveWorkspaceImageResolution(options)).image;
}

export { readBuildCacheStorage, type BuildCacheStorage } from "./build-cache.ts";
