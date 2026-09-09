import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireDocker } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { dockerServerPlatform } from "./local-images.ts";
import { workspaceImageKindLabel } from "./prune.ts";
import type { DockerRuntimeConnection } from "./runtime-connection.ts";

const digestSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const servicesSchema = Type.Object({ registryAddress: Type.String({ pattern: "^127\\.0\\.0\\.1:[0-9]+$" }) });
const metadataSchema = Type.Object({ "containerimage.digest": digestSchema });
const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
const relays = new Map<string, Bun.Server<undefined>>();

// The creator and its Docker daemon share a network namespace (the installed
// app uses host networking). Each inherited creator bridges its own loopback to
// the installation socket; it must never use the owner's loopback address.
function registryRelay(socket: string): string {
  let server = relays.get(socket);
  if (!server) {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      for (const name of hopHeaders) headers.delete(name);
      headers.set("host", "localhost");
      headers.set("accept-encoding", "identity");
      const upstream = await fetch(`http://localhost${url.pathname}${url.search}`, {
        unix: socket, method: request.method, headers, redirect: "manual",
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      });
      const responseHeaders = new Headers(upstream.headers);
      for (const name of hopHeaders) responseHeaders.delete(name);
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    } });
    server.unref();
    relays.set(socket, server);
  }
  return `127.0.0.1:${server.port}`;
}

export function sharedWorkspaceImageTag(tag: string, sourcePath: string): string {
  return `${tag}-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 16)}`;
}

async function baseReference(baseImage: string, registrySocket: string, registryAddress: string, localAddress: string): Promise<string> {
  // RepoDigests do not prove publication: Docker's containerd image store also
  // assigns them to locally built images. Publish the actual selected base once.
  const id = Value.Parse(digestSchema, (await requireDocker(["image", "inspect", "--format", "{{.Id}}", baseImage])).stdout.trim());
  const repo = `atelier/bases/${id.slice(7)}`;
  const manifest = () => fetch(`http://localhost/v2/${repo}/manifests/image`, { unix: registrySocket, method: "HEAD", headers: { accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json" } });
  let response = await manifest();
  if (response.status === 404) {
    const local = `${localAddress}/${repo}:image`;
    await requireDocker(["tag", baseImage, local]);
    await requireDocker(["push", local]);
    await requireDocker(["image", "rm", local]);
    response = await manifest();
  }
  if (!response.ok) throw new Error(`registry base lookup failed: ${response.status}`);
  return `${registryAddress}/${repo}@${Value.Parse(digestSchema, response.headers.get("docker-content-digest"))}`;
}

export interface SharedWorkspaceBuild {
  connection: DockerRuntimeConnection;
  sourcePath: string;
  dockerfile: string;
  originalDockerfile: string;
  baseImage: string;
  tag: string;
  noCache?: boolean;
  onOutput?: (chunk: string) => void | Promise<void>;
}

/** Solve the current context, publish by digest, and load that exact result into
 * the creator's Docker daemon. Existing tags never bypass the BuildKit solver. */
export async function buildSharedWorkspaceImage(options: SharedWorkspaceBuild): Promise<string> {
  if (!options.connection.buildServices) throw new Error("shared build connection lacks registry transport");
  // Discover the owner's address live rather than persisting it in each workspace.
  const discovery = await fetch("http://localhost/build-services", { unix: options.connection.adminSocket, signal: AbortSignal.timeout(30_000) });
  if (!discovery.ok) throw new Error(`shared build discovery failed: ${discovery.status}`);
  const services = { ...options.connection.buildServices, ...Value.Parse(servicesSchema, await discovery.json()) };
  const localAddress = registryRelay(services.registrySocket);
  const base = await baseReference(options.baseImage, services.registrySocket, services.registryAddress, localAddress);
  const directory = await mkdtemp(join(tmpdir(), "atelier-shared-build-"));
  try {
    await writeFile(join(directory, "Dockerfile"), await readFile(options.dockerfile));
    const specificIgnore = `${options.originalDockerfile}.dockerignore`;
    const ignore = await Bun.file(specificIgnore).exists() ? specificIgnore : join(options.sourcePath, ".dockerignore");
    if (await Bun.file(ignore).exists()) await writeFile(join(directory, "Dockerfile.dockerignore"), await readFile(ignore));
    const metadata = join(directory, "result.json");
    const proc = Bun.spawn(["buildctl", "--addr", `unix://${services.buildkitSocket}`, "build", "--frontend", "dockerfile.v0",
      "--local", `context=${options.sourcePath}`, "--local", `dockerfile=${directory}`,
      "--opt", "frontend.caps=moby.buildkit.frontend.contexts+forward", "--opt", `context:atelier-workspace=docker-image://${base}`,
      "--opt", `platform=${await dockerServerPlatform()}`, "--opt", `label:${workspaceImageKindLabel}=repository`,
      ...(options.noCache ? ["--no-cache"] : []), "--progress", "plain", "--metadata-file", metadata,
      "--output", `type=image,name=${services.registryAddress}/atelier/workspaces,push=true,push-by-digest=true`,
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
    const local = `${localAddress}/atelier/workspaces@${digest}`;
    const immutable = `atelier-workspace:${digest.slice(7)}`;
    await requireDocker(["pull", local]);
    await requireDocker(["tag", local, immutable]);
    await requireDocker(["tag", local, options.tag]);
    await requireDocker(["image", "rm", local]);
    return immutable;
  } finally { await rm(directory, { recursive: true }); }
}
