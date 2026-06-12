import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDocker, runDocker } from "./docker.ts";

interface WorkspaceImageMetadata { tag: string; modules: string[] }

let ensuredImage: Promise<string> | undefined;

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

export async function resolveWorkspaceImage(): Promise<string> {
  ensuredImage ??= buildWorkspaceImageOnDemand();
  return await ensuredImage;
}

async function buildWorkspaceImageOnDemand(): Promise<string> {
  const root = repoRoot();
  const script = join(root, "packages/workspace-image/scripts/build-context.mjs");
  if (!existsSync(script)) throw new Error(`workspace image context generator not found: ${script}`);

  const contextDir = process.env.ATELIER_WORKSPACE_IMAGE_CONTEXT || join(root, ".atelier-workspace-image-context", namespaceSlug());
  await rm(contextDir, { recursive: true, force: true });
  await mkdir(contextDir, { recursive: true });

  const generated = Bun.spawnSync(["bun", script, contextDir], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (generated.exitCode !== 0) throw new Error(`could not generate workspace image context: ${generated.stderr.toString() || generated.stdout.toString()}`);

  const metadata = await contextMetadata(contextDir);
  const tag = `${metadata.tag}-${createHash("sha256").update(namespaceSlug()).digest("hex").slice(0, 8)}`;
  if (await imageExists(tag)) return tag;

  await requireDocker(["build", "-t", tag, "-f", join(contextDir, "Dockerfile"), contextDir]);
  return tag;
}
