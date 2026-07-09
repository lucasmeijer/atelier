import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atelierDataPath, dockerHostAtelierDataPath, getAtelierRuntimeContext, requireDocker, runDocker, shellQuote, type AtelierEventBus } from "@atelier/core";
import { runHostObservableCommand } from "@atelier/observable-terminal/server";

interface WorkspaceImageMetadata { tag: string; modules: string[] }

interface WorkspaceImageBuildTask {
  tag: string;
  modules: string[];
  output: string;
  session?: string;
  promise: Promise<void>;
}

export interface ResolveWorkspaceImageOptions {
  workspaceId?: string;
  events?: AtelierEventBus;
  sourcePath?: string;
  buildOutput?: "inherit";
}

export interface WorkspaceImageResolution {
  image: string;
  defaultImage: string;
  repoImage?: string;
}

export interface AtelierWorkspaceImagePreloadMount {
  type: "bind";
  source: string;
  target: string;
  readonly: true;
}

export interface AtelierWorkspaceImagePreload {
  refs: string[];
  mount: AtelierWorkspaceImagePreloadMount;
  initScript: string;
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
  return JSON.parse(await readFile(join(contextDir, "metadata.json"), "utf8")) as WorkspaceImageMetadata;
}

async function imageExists(tag: string): Promise<boolean> {
  const result = await runDocker(["image", "inspect", tag]);
  return result.exitCode === 0;
}

async function pullImage(tag: string): Promise<void> {
  if (await imageExists(tag)) return;
  const result = await runDocker(["pull", tag]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `docker pull ${tag} failed`);
}

function appendOutput(task: WorkspaceImageBuildTask, chunk: string): void {
  task.output = `${task.output}${chunk}`;
  if (task.output.length > maxBuildOutputBytes) task.output = task.output.slice(-maxBuildOutputBytes);
}

function tailOutput(output: string): string {
  const lines = output.replaceAll("\r", "").split("\n");
  return lines.slice(-120).join("\n").trimEnd();
}

function imageDetail(task: Pick<WorkspaceImageBuildTask, "tag" | "modules">): string {
  return `Image: ${task.tag}${task.modules.length ? ` · Modules: ${task.modules.join(", ")}` : ""}`;
}

async function emitImageStep(events: AtelierEventBus | undefined, workspaceId: string | undefined, task: WorkspaceImageBuildTask, status: "running" | "done" | "failed", error?: string): Promise<void> {
  if (!events || !workspaceId) return;
  await events.emit("workspace_provision_step", {
    workspaceId,
    id: "workspace.image",
    label: "Resolve workspace image",
    status,
    detail: imageDetail(task),
    output: tailOutput(task.output),
    ...(task.session ? { terminal: { kind: "host-tmux" as const, session: task.session } } : {}),
    error,
  });
}

function dockerBuildArgs(tag: string, dockerfile: string, contextDir: string, options: ResolveWorkspaceImageOptions): string[] {
  return [
    "build",
    ...(options.buildOutput === "inherit" ? ["--progress=plain"] : []),
    ...(process.env.ATELIER_WORKSPACE_IMAGE_NO_CACHE === "1" ? ["--no-cache"] : []),
    "-t", tag,
    "-f", dockerfile,
    contextDir,
  ];
}

function startBuildTask(tag: string, modules: string[], dockerfile: string, contextDir: string, options: ResolveWorkspaceImageOptions): WorkspaceImageBuildTask {
  const existing = buildTasks.get(tag);
  if (existing) return existing;

  const task: WorkspaceImageBuildTask = { tag, modules, output: "", promise: Promise.resolve() };
  task.promise = (async () => {
    const args = dockerBuildArgs(tag, dockerfile, contextDir, options);
    if (options.buildOutput === "inherit") {
      const proc = Bun.spawn(["docker", ...args], { cwd: contextDir, env: { ...process.env, DOCKER_BUILDKIT: "1" }, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) throw new Error(`docker build failed with exit code ${exitCode}`);
      return;
    }
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
  })().finally(() => {
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
    throw new Error(`${message}\n\n${tailOutput(task.output)}`.trim());
  }
}

async function generateContext(contextDir: string, args: string[] = []): Promise<void> {
  const root = repoRoot();
  const script = join(root, "packages/workspace-image/scripts/build-context.mjs");
  if (!existsSync(script)) throw new Error(`workspace image context generator not found: ${script}`);
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });
  const generated = Bun.spawnSync(["bun", script, contextDir, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (generated.exitCode !== 0) throw new Error(`could not generate workspace image context: ${generated.stderr.toString() || generated.stdout.toString()}`);
}

async function bakedDefaultWorkspaceImageRef(): Promise<string | undefined> {
  const file = Bun.file(defaultImageRefFile);
  if (!(await file.exists())) return undefined;
  const ref = (await file.text()).trim();
  return ref || undefined;
}

async function ensureBuiltImage(contextDir: string, dockerfile: string, metadata: WorkspaceImageMetadata, options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  if (await imageExists(metadata.tag)) return metadata.tag;
  const task = startBuildTask(metadata.tag, metadata.modules, dockerfile, contextDir, options);
  await waitForBuildTask(task, options);
  return metadata.tag;
}

export async function ensureDefaultWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  const baked = await bakedDefaultWorkspaceImageRef();
  if (baked) {
    await pullImage(baked);
    return baked;
  }

  const contextDir = defaultContextDir();
  await generateContext(contextDir);
  const metadata = await contextMetadata(contextDir);
  return await ensureBuiltImage(contextDir, join(contextDir, "Dockerfile"), metadata, options);
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

function addAptCacheMount(instruction: string): { instruction: string; changed: boolean } {
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

async function repoWorkspaceImageMetadata(dockerfile: string, baseImage: string): Promise<WorkspaceImageMetadata> {
  await assertWorkspaceDockerfileBase(dockerfile);
  const hash = createHash("sha256");
  hash.update("atelier-repo-workspace-dockerfile-v5\n");
  hash.update(baseImage); hash.update("\0");
  hash.update(await readFile(dockerfile)); hash.update("\0");
  return { tag: `atelier-workspace:${hash.digest("hex").slice(0, 16)}`, modules: ["repo"] };
}

async function tagAtelierWorkspaceBase(baseImage: string): Promise<void> {
  const result = await runDocker(["tag", baseImage, "atelier-workspace"]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `docker tag ${baseImage} atelier-workspace failed`);
}

const workspaceImagePreloadMountPath = "/.atelier/preload-workspace-images";
const workspaceImagePreloadTasks = new Map<string, Promise<void>>();

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function dockerImageId(ref: string): Promise<string> {
  const inspected = await requireDocker(["image", "inspect", "--format", "{{.Id}}", ref]);
  return inspected.stdout.trim();
}

async function workspaceImagePreloadKey(refs: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const ref of refs) {
    hash.update(ref); hash.update("\0");
    hash.update(await dockerImageId(ref)); hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

function dockerRefTag(ref: string): string | undefined {
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon <= slash) return undefined;
  return ref.slice(colon + 1);
}

function defaultWorkspaceImageLocalAlias(defaultImage: string): string | undefined {
  const tag = dockerRefTag(defaultImage);
  if (!tag || !/^[a-f0-9]{16}$/.test(tag)) return undefined;
  return `atelier-workspace:${tag}`;
}

async function repoWorkspaceImageLocalAlias(sourcePath: string, baseImage: string): Promise<string | undefined> {
  const dockerfile = join(sourcePath, ".atelier", "Dockerfile");
  if (!(await Bun.file(dockerfile).exists())) return undefined;
  return (await repoWorkspaceImageMetadata(dockerfile, baseImage)).tag;
}

async function tagWorkspaceImagePreloadAliases(sourceRef: string, aliases: string[]): Promise<string[]> {
  const tagged: string[] = [];
  for (const alias of aliases) {
    if (alias === sourceRef) continue;
    await requireDocker(["tag", sourceRef, alias]);
    tagged.push(alias);
  }
  return tagged;
}

async function ensureWorkspaceImagePreloadTar(dir: string, refs: string[]): Promise<void> {
  const tarPath = join(dir, "workspace-images.tar");
  const completePath = join(dir, "complete");
  if (await Bun.file(completePath).exists()) return;
  const existing = workspaceImagePreloadTasks.get(tarPath);
  if (existing) return await existing;

  const task = (async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await requireDocker(["save", "--output", tarPath, ...refs]);
    await writeFile(join(dir, "refs.txt"), `${refs.join("\n")}\n`);
    await writeFile(completePath, "");
  })().finally(() => {
    workspaceImagePreloadTasks.delete(tarPath);
  });
  workspaceImagePreloadTasks.set(tarPath, task);
  await task;
}

function workspaceImagePreloadInitScript(refs: string[]): string {
  const quotedRefs = refs.map(shellQuote).join(" ");
  return `preload_dir=${shellQuote(workspaceImagePreloadMountPath)}
preload_tar="$preload_dir/workspace-images.tar"
missing=0
for ref in ${quotedRefs}; do
  docker image inspect "$ref" >/dev/null 2>&1 || missing=1
done
if [ "$missing" = 1 ]; then
  docker info >/dev/null 2>&1 || { echo "workspace image preload requires a running Docker daemon" >&2; exit 1; }
  docker load --input "$preload_tar"
fi
for ref in ${quotedRefs}; do
  docker image inspect "$ref" >/dev/null
done`;
}

export async function resolveWorkspaceImageResolution(options: ResolveWorkspaceImageOptions = {}): Promise<WorkspaceImageResolution> {
  const baseImage = await ensureDefaultWorkspaceImage();
  if (!options.sourcePath) return { image: baseImage, defaultImage: baseImage };

  const dockerfile = join(options.sourcePath, ".atelier", "Dockerfile");
  if (!(await Bun.file(dockerfile).exists())) return { image: baseImage, defaultImage: baseImage };

  await tagAtelierWorkspaceBase(baseImage);
  const metadata = await repoWorkspaceImageMetadata(dockerfile, baseImage);
  const buildDockerfile = await optimizedRepoDockerfile(options.sourcePath, dockerfile);
  const repoImage = await ensureBuiltImage(options.sourcePath, buildDockerfile, metadata, options);
  return { image: repoImage, defaultImage: baseImage, repoImage };
}

export async function resolveWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  return (await resolveWorkspaceImageResolution(options)).image;
}

export async function prepareAtelierWorkspaceImagePreload(options: { sourcePath?: string; resolution: WorkspaceImageResolution }): Promise<AtelierWorkspaceImagePreload> {
  const defaultImage = options.resolution.defaultImage;

  // Released Atelier images bake a registry default image ref, but source-checkout
  // Atelier (the common nested-dev case) computes and checks for the local
  // deterministic `atelier-workspace:<hash>` tag. The repo workspace image tag
  // also includes the default image ref string in its hash. Save these local
  // aliases too so the inner daemon satisfies both default and repo image checks
  // without rebuilding while still running as an isolated Docker-in-Docker daemon.
  const defaultAlias = defaultWorkspaceImageLocalAlias(defaultImage);
  const defaultAliases = defaultAlias ? await tagWorkspaceImagePreloadAliases(defaultImage, [defaultAlias]) : [];
  const repoAlias = options.sourcePath && defaultAlias ? await repoWorkspaceImageLocalAlias(options.sourcePath, defaultAlias) : undefined;
  const repoAliases = repoAlias && options.resolution.repoImage ? await tagWorkspaceImagePreloadAliases(options.resolution.repoImage, [repoAlias]) : [];

  const refs = uniqueStrings([defaultImage, ...defaultAliases, options.resolution.image, ...repoAliases]);
  const runtime = await getAtelierRuntimeContext();
  const key = await workspaceImagePreloadKey(refs);
  const dir = atelierDataPath(runtime, "image-preloads", key);
  await ensureWorkspaceImagePreloadTar(dir, refs);

  return {
    refs,
    mount: { type: "bind", source: dockerHostAtelierDataPath(runtime, "image-preloads", key), target: workspaceImagePreloadMountPath, readonly: true },
    initScript: workspaceImagePreloadInitScript(refs),
  };
}
