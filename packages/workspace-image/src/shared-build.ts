import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireDocker } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { dockerServerPlatform } from "./local-images.ts";
import { workspaceImageKindLabel } from "./prune.ts";
import { dockerRegistryAddress, loopbackRegistryAddress, type DockerRuntimeConnection } from "./runtime-connection.ts";

const digestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const metadataSchema = Type.Object({ "containerimage.digest": digestSchema });
const publications = new Map<string, Promise<string>>();

export function sharedWorkspaceImageTag(tag: string, sourcePath: string): string {
  return `${tag}-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`;
}

const manifestAccept = "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json";
async function manifestDigest(address: string, repo: string, tag: string): Promise<string | undefined> {
  const response = await fetch(`http://${address}/v2/${repo}/manifests/${tag}`, { method: "HEAD", headers: { accept: manifestAccept } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`registry image lookup failed: ${response.status}`);
  return Value.Parse(digestSchema, response.headers.get("docker-content-digest"));
}

async function publishImageReference(id: string, address: string): Promise<string> {
  // RepoDigests alone do not prove publication. The builder records its actual
  // published outputs so metadata-only private stores never have to re-export them.
  const built = await manifestDigest(address, "atelier/workspaces", `image-${id.slice(7)}`);
  if (built) return `atelier/workspaces@${built}`;
  const repo = `atelier/bases/${id.slice(7)}`;
  let digest = await manifestDigest(address, repo, "image");
  if (!digest) {
    const local = `${address}/${repo}:image`;
    await requireDocker(["tag", id, local]);
    await requireDocker(["push", local]);
    await requireDocker(["image", "rm", local]);
    digest = await manifestDigest(address, repo, "image");
    if (!digest) throw new Error("registry did not retain the published image");
  }
  return `${repo}@${digest}`;
}

async function rememberBuiltImage(address: string, id: string, digest: string): Promise<void> {
  const response = await fetch(`http://${address}/v2/atelier/workspaces/manifests/${digest}`, { headers: { accept: manifestAccept } });
  if (!response.ok) throw new Error(`registry build lookup failed: ${response.status}`);
  const type = response.headers.get("content-type");
  if (!type) throw new Error("registry build manifest lacks its media type");
  const saved = await fetch(`http://${address}/v2/atelier/workspaces/manifests/image-${id.slice(7)}`, { method: "PUT", headers: { "content-type": type }, body: await response.arrayBuffer() });
  if (!saved.ok) throw new Error(`registry build indexing failed: ${saved.status}`);
}

/** Publish the selected Docker image; return a digest reference relative to the
 * installation registry. */
export async function publishSharedImage(connection: DockerRuntimeConnection, image: string): Promise<string> {
  if (!connection.buildServices) throw new Error("shared image publication requires a registry connection");
  const id = Value.Parse(digestSchema, (await requireDocker(["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim());
  const address = dockerRegistryAddress(connection);
  const key = `${address}\0${id}`;
  let publication = publications.get(key);
  if (!publication) {
    // Concurrent preloads share one temporary Docker tag; keep its lifetime owned
    // by one publication rather than removing it beneath another push.
    publication = publishImageReference(id, address).finally(() => publications.delete(key));
    publications.set(key, publication);
  }
  return await publication;
}

interface SharedBuildOptions {
  connection: DockerRuntimeConnection;
  sourcePath: string;
  dockerfile: string;
  originalDockerfile: string;
  tag: string;
  noCache?: boolean;
  onOutput?: (chunk: string) => void | Promise<void>;
}

export type SharedWorkspaceBuild = SharedBuildOptions & ({ kind: "default" } | { kind: "repository"; baseImage: string });

/** Solve the current context, publish by digest, and load that exact result into
 * the creator's Docker daemon. Existing tags never bypass the BuildKit solver. */
export async function buildSharedWorkspaceImage(options: SharedWorkspaceBuild): Promise<string> {
  if (!options.connection.buildServices) throw new Error("shared build connection lacks registry transport");
  const services = options.connection.buildServices;
  const builderAddress = loopbackRegistryAddress(services.registryAddress);
  const creatorAddress = dockerRegistryAddress(options.connection);
  const base = options.kind === "repository" ? `${builderAddress}/${await publishSharedImage(options.connection, options.baseImage)}` : undefined;
  const directory = await mkdtemp(join(tmpdir(), "atelier-shared-build-"));
  try {
    await writeFile(join(directory, "Dockerfile"), await readFile(options.dockerfile));
    const specificIgnore = `${options.originalDockerfile}.dockerignore`;
    const ignore = await Bun.file(specificIgnore).exists() ? specificIgnore : join(options.sourcePath, ".dockerignore");
    if (await Bun.file(ignore).exists()) await writeFile(join(directory, "Dockerfile.dockerignore"), await readFile(ignore));
    const metadata = join(directory, "result.json");
    const proc = Bun.spawn(["buildctl", "--addr", `unix://${services.buildkitSocket}`, "build", "--frontend", "dockerfile.v0",
      "--local", `context=${options.sourcePath}`, "--local", `dockerfile=${directory}`,
      ...(base ? ["--opt", "frontend.caps=moby.buildkit.frontend.contexts+forward", "--opt", `context:atelier-workspace=docker-image://${base}`] : []),
      "--opt", `platform=${await dockerServerPlatform()}`, "--opt", `label:${workspaceImageKindLabel}=${options.kind}`,
      ...(options.noCache ? ["--no-cache"] : []), "--progress", "plain", "--metadata-file", metadata,
      "--output", `type=image,name=${builderAddress}/atelier/workspaces,push=true,push-by-digest=true`,
    ], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let output = "";
    const publish = async (text: string) => { output = (output + text).slice(-64 * 1024); await options.onOutput?.(text); };
    const consume = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) await publish(decoder.decode(chunk, { stream: true }));
      await publish(decoder.decode());
    };
    let code: number;
    try { [code] = await Promise.all([proc.exited, consume(proc.stdout), consume(proc.stderr)]); }
    finally { if (proc.exitCode === null) { proc.kill(); await proc.exited; } }
    if (code !== 0) throw new Error(`shared workspace build failed with exit code ${code}\n${output}`);
    const result = Value.Parse(metadataSchema, JSON.parse(await readFile(metadata, "utf8")));
    const digest = result["containerimage.digest"];
    const local = `${creatorAddress}/atelier/workspaces@${digest}`;
    const immutable = `atelier-workspace:${digest.slice(7)}`;
    await requireDocker(["pull", local]);
    const id = Value.Parse(digestSchema, (await requireDocker(["image", "inspect", "--format", "{{.Id}}", local])).stdout.trim());
    await rememberBuiltImage(creatorAddress, id, digest);
    await requireDocker(["tag", local, immutable]);
    await requireDocker(["tag", local, options.tag]);
    await requireDocker(["image", "rm", local]);
    return immutable;
  } finally { await rm(directory, { recursive: true }); }
}
