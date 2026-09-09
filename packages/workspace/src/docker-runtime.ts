import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceDockerPlan } from "./types.ts";

export const dockerRuntimeConnectionPath = "/.atelier/docker-runtime.json";
const absolutePath = Type.String({ pattern: "^/[^\\r\\n,]*$" });
const connectionSchema = Type.Object({
  version: Type.Literal(1), adminSocket: absolutePath, snapshotterRoot: absolutePath,
  socketDirectory: absolutePath, depth: Type.Integer({ minimum: 0, maximum: 11 }),
  buildServices: Type.Optional(Type.Object({ buildkitSocket: absolutePath, registrySocket: absolutePath })),
});
export type DockerRuntimeConnection = Static<typeof connectionSchema>;
const registrationSchema = Type.Object({ clientId: Type.String({ pattern: "^[a-f0-9]{24}$" }), connection: connectionSchema });

async function optionalFile(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
export async function readDockerRuntimeConnection(path = dockerRuntimeConnectionPath): Promise<DockerRuntimeConnection | undefined> {
  const text = await optionalFile(path);
  if (text === undefined) return undefined;
  const connection = Value.Parse(connectionSchema, JSON.parse(text));
  if (connection.adminSocket !== join(connection.socketDirectory, "admin.sock")) throw new Error("invalid shared Docker administrative socket");
  if (connection.buildServices && (connection.buildServices.buildkitSocket !== join(connection.socketDirectory, "buildkit.sock") || connection.buildServices.registrySocket !== join(connection.socketDirectory, "registry.sock"))) throw new Error("invalid shared Docker build service sockets");
  return connection;
}
async function request(connection: DockerRuntimeConnection, operation: "register" | "retire", clientId: string): Promise<void> {
  const response = await fetch(`http://localhost/${operation}?${new URLSearchParams({ client: clientId })}`, {
    method: "POST", unix: connection.adminSocket, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`snapshotter ${operation} failed (${response.status}): ${await response.text()}`);
}

export async function registerWorkspaceDocker(plan: WorkspaceDockerPlan, directory: string, connection: DockerRuntimeConnection): Promise<void> {
  if (plan.sharedDocker) throw new Error("workspace plan cannot replace the installation-owned Docker runtime");
  if (connection.depth > 10) throw new Error("shared Docker nesting exceeds the supported network depth");
  const clientId = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  await mkdir(directory, { recursive: true });
  // Record before the request: a lost response must not lose ownership information.
  await writeFile(join(directory, "registration.json.tmp"), JSON.stringify({ clientId, connection }));
  await rename(join(directory, "registration.json.tmp"), join(directory, "registration.json"));
  await request(connection, "register", clientId);
  const nested = { ...connection, depth: connection.depth + 1 };
  const source = join(directory, "connection.json");
  await writeFile(source, JSON.stringify(nested));
  plan.containerFiles.push({ source, target: dockerRuntimeConnectionPath });
  plan.sharedDocker = {
    snapshotterSocket: join(connection.socketDirectory, `${clientId}.sock`),
    snapshotterRoot: connection.snapshotterRoot,
    bridgeCIDR: `10.${231 + 2 * connection.depth}.0.1/24`,
    addressPool: `10.${232 + 2 * connection.depth}.0.0/16`,
  };
}

export async function retireWorkspaceDocker(directory: string): Promise<void> {
  const text = await optionalFile(join(directory, "registration.json"));
  if (text === undefined) return;
  const registration = Value.Parse(registrationSchema, JSON.parse(text));
  await request(registration.connection, "retire", registration.clientId);
}

/** Docker paths resolve in the containing workspace when launching a nested Atelier image. */
export function inheritedDockerMountArgs(connection: DockerRuntimeConnection): string[] {
  return [connection.snapshotterRoot, connection.socketDirectory, dockerRuntimeConnectionPath].flatMap((path) => {
    if (!isAbsolute(path)) throw new Error("shared Docker mount paths must be absolute");
    return ["--mount", `type=bind,src=${path},dst=${path}${path === connection.snapshotterRoot ? "" : ",readonly"}`];
  });
}
