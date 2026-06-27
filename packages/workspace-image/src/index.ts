import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDocker, shellQuote, type AtelierEventBus } from "@atelier/core";
import { runHostObservableCommand } from "@atelier/observable-terminal/server";

interface WorkspaceImageMetadata { tag: string; modules: string[]; baseImage?: string }

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

function workspaceContextDir(workspaceId: string | undefined): string {
  return join(contextBaseDir(), workspaceId ?? crypto.randomUUID());
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

function startBuildTask(tag: string, modules: string[], dockerfile: string, contextDir: string, options: ResolveWorkspaceImageOptions): WorkspaceImageBuildTask {
  const existing = buildTasks.get(tag);
  if (existing) return existing;

  const task: WorkspaceImageBuildTask = { tag, modules, output: "", promise: Promise.resolve() };
  task.promise = (async () => {
    const args = ["build", ...(process.env.ATELIER_WORKSPACE_IMAGE_NO_CACHE === "1" ? ["--no-cache"] : []), "-t", tag, "-f", dockerfile, contextDir];
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

async function ensureBuiltImage(contextDir: string, metadata: WorkspaceImageMetadata, options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  if (await imageExists(metadata.tag)) return metadata.tag;
  const task = startBuildTask(metadata.tag, metadata.modules, join(contextDir, "Dockerfile"), contextDir, options);
  await waitForBuildTask(task, options);
  return metadata.tag;
}

export async function ensureDefaultWorkspaceImage(): Promise<string> {
  const baked = await bakedDefaultWorkspaceImageRef();
  if (baked) {
    await pullImage(baked);
    return baked;
  }

  const contextDir = defaultContextDir();
  await generateContext(contextDir);
  const metadata = await contextMetadata(contextDir);
  return await ensureBuiltImage(contextDir, metadata);
}

async function hasRepoWorkspaceImageManifest(sourcePath: string | undefined): Promise<boolean> {
  if (!sourcePath) return false;
  return await Bun.file(join(sourcePath, ".atelier", "workspace.json")).exists();
}

export async function resolveWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  const baseImage = await ensureDefaultWorkspaceImage();
  if (!(await hasRepoWorkspaceImageManifest(options.sourcePath))) return baseImage;

  const contextDir = workspaceContextDir(options.workspaceId);
  await generateContext(contextDir, [options.sourcePath!, "--base-image", baseImage]);
  const metadata = await contextMetadata(contextDir);
  return await ensureBuiltImage(contextDir, metadata, options);
}
