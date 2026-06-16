import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDocker } from "@atelier/core";
import type { AtelierEventBus } from "@atelier/core";

interface WorkspaceImageMetadata { tag: string; modules: string[] }

interface WorkspaceImageBuildTask {
  tag: string;
  modules: string[];
  output: string;
  promise: Promise<void>;
}

export interface ResolveWorkspaceImageOptions {
  workspaceId?: string;
  events?: AtelierEventBus;
  // Source checkout path is available before the container starts. Current image
  // resolution does not inspect it yet, but repo-aware image selection/building
  // can use this path without needing docker exec cloning.
  sourcePath?: string;
}

const maxBuildOutputBytes = 64 * 1024;
const buildUpdateIntervalMs = 5_000;
const buildTasks = new Map<string, WorkspaceImageBuildTask>();

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function namespaceSlug(): string {
  return (process.env.ATELIER_NAMESPACE || "default").replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
}

async function contextMetadata(contextDir: string): Promise<WorkspaceImageMetadata> {
  return JSON.parse(await readFile(join(contextDir, "metadata.json"), "utf8")) as WorkspaceImageMetadata;
}

async function imageExists(tag: string): Promise<boolean> {
  const result = await runDocker(["image", "inspect", tag]);
  return result.exitCode === 0;
}

function appendOutput(task: WorkspaceImageBuildTask, chunk: string): void {
  task.output = `${task.output}${chunk}`;
  if (task.output.length > maxBuildOutputBytes) task.output = task.output.slice(-maxBuildOutputBytes);
}

function tailOutput(output: string): string {
  const lines = output.replaceAll("\r", "").split("\n");
  return lines.slice(-120).join("\n").trimEnd();
}

async function emitBuildEvent(
  events: AtelierEventBus | undefined,
  eventName: "workspace_image_build_started" | "workspace_image_build_output" | "workspace_image_build_finished",
  workspaceId: string | undefined,
  task: WorkspaceImageBuildTask,
  error?: string,
): Promise<void> {
  if (!events || !workspaceId) return;
  await events.emit(eventName, {
    workspaceId,
    image: task.tag,
    modules: task.modules,
    output: tailOutput(task.output),
    error,
  });
}

async function readBuildStream(task: WorkspaceImageBuildTask, stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) appendOutput(task, decoder.decode(chunk, { stream: true }));
  appendOutput(task, decoder.decode());
}

interface BuildxBuilderListing {
  Current?: boolean;
  Driver?: string;
  Name?: string;
  Nodes?: Array<{ Endpoint?: string; Status?: string }>;
}

function dockerBuildxBuilderArgs(): string[] {
  const context = Bun.spawnSync(["docker", "context", "show"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  const listed = Bun.spawnSync(["docker", "buildx", "ls", "--format", "{{json .}}"], { stdout: "pipe", stderr: "ignore" });
  if (listed.exitCode !== 0) return [];

  const builders = listed.stdout.toString().split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line): BuildxBuilderListing[] => {
    try {
      return [JSON.parse(line) as BuildxBuilderListing];
    } catch {
      return [];
    }
  });
  const dockerBuilders = builders.filter((builder) => builder.Driver === "docker" && builder.Name);
  const contextBuilder = dockerBuilders.find((builder) => builder.Nodes?.some((node) => node.Endpoint === context && node.Status === "running"));
  const currentBuilder = dockerBuilders.find((builder) => builder.Current && builder.Nodes?.some((node) => node.Status === "running"));
  const runningBuilder = dockerBuilders.find((builder) => builder.Nodes?.some((node) => node.Status === "running"));
  const builder = contextBuilder ?? currentBuilder ?? runningBuilder;
  return builder?.Name ? ["--builder", builder.Name] : [];
}

function startBuildTask(tag: string, modules: string[], dockerfile: string, contextDir: string): WorkspaceImageBuildTask {
  const existing = buildTasks.get(tag);
  if (existing) return existing;

  const task: WorkspaceImageBuildTask = {
    tag,
    modules,
    output: "",
    promise: Promise.resolve(),
  };

  task.promise = (async () => {
    const proc = Bun.spawn(["docker", "buildx", "build", ...dockerBuildxBuilderArgs(), "--load", "--progress=plain", "-t", tag, "-f", dockerfile, contextDir], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DOCKER_BUILDKIT: "1",
        BUILDKIT_PROGRESS: "plain",
      },
    });
    await Promise.all([readBuildStream(task, proc.stdout), readBuildStream(task, proc.stderr)]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`docker build failed with exit code ${exitCode}`);
  })().finally(() => {
    buildTasks.delete(tag);
  });

  buildTasks.set(tag, task);
  return task;
}

async function waitForBuildTask(task: WorkspaceImageBuildTask, options: ResolveWorkspaceImageOptions): Promise<void> {
  await emitBuildEvent(options.events, "workspace_image_build_started", options.workspaceId, task);
  const interval = setInterval(() => {
    void emitBuildEvent(options.events, "workspace_image_build_output", options.workspaceId, task);
  }, buildUpdateIntervalMs);

  try {
    await task.promise;
    await emitBuildEvent(options.events, "workspace_image_build_finished", options.workspaceId, task);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitBuildEvent(options.events, "workspace_image_build_finished", options.workspaceId, task, message);
    throw new Error(`${message}\n\n${tailOutput(task.output)}`.trim());
  } finally {
    clearInterval(interval);
  }
}

export async function resolveWorkspaceImage(options: ResolveWorkspaceImageOptions = {}): Promise<string> {
  const root = repoRoot();
  const script = join(root, "packages/workspace-image/scripts/build-context.mjs");
  if (!existsSync(script)) throw new Error(`workspace image context generator not found: ${script}`);

  const contextDir = process.env.ATELIER_WORKSPACE_IMAGE_CONTEXT || join(root, ".atelier-workspace-image-context", namespaceSlug(), options.workspaceId ?? crypto.randomUUID());
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });

  const generated = Bun.spawnSync(["bun", script, contextDir, ...(options.sourcePath ? [options.sourcePath] : [])], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (generated.exitCode !== 0) throw new Error(`could not generate workspace image context: ${generated.stderr.toString() || generated.stdout.toString()}`);

  const metadata = await contextMetadata(contextDir);
  const tag = `${metadata.tag}-${createHash("sha256").update(namespaceSlug()).digest("hex").slice(0, 8)}`;
  if (await imageExists(tag)) return tag;

  const task = startBuildTask(tag, metadata.modules, join(contextDir, "Dockerfile"), contextDir);
  await waitForBuildTask(task, options);
  return tag;
}
