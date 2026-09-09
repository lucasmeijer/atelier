import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const dockerRuntimeConnectionPath = "/.atelier/docker-runtime.json";
const absolutePath = Type.String({ pattern: "^/[^\\r\\n,]*$" });
export const dockerRuntimeConnectionSchema = Type.Object({
  version: Type.Literal(1), adminSocket: absolutePath, snapshotterRoot: absolutePath,
  socketDirectory: absolutePath, depth: Type.Integer({ minimum: 0, maximum: 11 }),
  buildServices: Type.Optional(Type.Object({ buildkitSocket: absolutePath, registrySocket: absolutePath })),
});
export type DockerRuntimeConnection = Static<typeof dockerRuntimeConnectionSchema>;
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
  const connection = Value.Parse(dockerRuntimeConnectionSchema, JSON.parse(text));
  if (connection.adminSocket !== join(connection.socketDirectory, "admin.sock")) throw new Error("invalid shared Docker administrative socket");
  if (connection.buildServices && (connection.buildServices.buildkitSocket !== join(connection.socketDirectory, "buildkit.sock") || connection.buildServices.registrySocket !== join(connection.socketDirectory, "registry.sock"))) throw new Error("invalid shared Docker build service sockets");
  return connection;
}
