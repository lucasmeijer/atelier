import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocker, workloadBuildArgs, type CommandResult } from "@atelier/core";
import { reuseDefaultWorkspaceImage } from "./local-images.ts";
import { parseWorkspaceImageMetadata, type WorkspaceImageMetadata } from "./metadata.ts";

export interface DefaultWorkspaceImageContext {
  contextDir: string;
  dockerfile: string;
  metadata: WorkspaceImageMetadata;
  dispose(): Promise<void>;
}

type DockerCommand = (args: string[]) => Promise<CommandResult>;
export interface EnsureDefaultImageOptions {
  docker?: DockerCommand;
  force?: boolean;
  /** Publishing can use the same identity and preparation with a registry tag. */
  imageName?: (contentTag: string) => string;
  exists?: (image: string) => Promise<boolean>;
  build?: (context: DefaultWorkspaceImageContext, image: string) => Promise<void>;
  /** A prepared context can be shared by publication and app build metadata. */
  context?: DefaultWorkspaceImageContext;
}

const root = join(import.meta.dir, "../../..");

/** Always regenerate: edits to module inputs in a long-lived dev process count. */
export async function prepareDefaultWorkspaceImage(): Promise<DefaultWorkspaceImageContext> {
  const contextDir = await mkdtemp(join(tmpdir(), "atelier-workspace-image-"));
  const dispose = () => rm(contextDir, { recursive: true, force: true });
  try {
    const process = Bun.spawn(["bun", join(root, "packages/workspace-image/scripts/build-context.mjs"), contextDir], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (code !== 0) throw new Error(`Could not generate workspace image: ${stderr || stdout}`);
    const metadata = parseWorkspaceImageMetadata(JSON.parse(await readFile(join(contextDir, "metadata.json"), "utf8")));
    return { contextDir, dockerfile: join(contextDir, "Dockerfile"), metadata, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Resolve the signature in the selected image store, building only on a miss.
 * Publishers supply their own registry-tag existence check. */
export async function ensureGeneratedDefaultWorkspaceImage(options: EnsureDefaultImageOptions = {}): Promise<string> {
  const context = options.context ?? await prepareDefaultWorkspaceImage();
  const docker = options.docker ?? runDocker;
  const image = options.imageName?.(context.metadata.tag) ?? context.metadata.tag;
  try {
    if (!options.force && await (options.exists ? options.exists(image) : reuseDefaultWorkspaceImage(image, docker))) return image;
    if (options.build) await options.build(context, image);
    else {
      const result = await docker(["build", ...await workloadBuildArgs(), "--progress=plain", "--label", "com.atelier.workspace-image.kind=default", "-t", image, "-f", context.dockerfile, context.contextDir]);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `Could not build ${image}`);
    }
    return image;
  } finally {
    if (!options.context) await context.dispose();
  }
}
