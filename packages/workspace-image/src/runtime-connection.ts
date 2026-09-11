import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const dockerRuntimeConnectionPath = "/.atelier/docker-runtime.json";
const absolutePath = Type.String({ pattern: "^/[^\\r\\n,]*$" });
export const registryHostname = "atelier-registry.localhost";
export const registryAddress = `${registryHostname}:42000`;
export const registryLoopbackAddress = "127.0.0.1:42000";
export const registryAddressSchema = Type.Literal(registryAddress);

export const dockerRuntimeConnectionSchema = Type.Object({
  version: Type.Literal(1), adminSocket: absolutePath, snapshotterRoot: absolutePath,
  socketDirectory: absolutePath, depth: Type.Integer({ minimum: 0, maximum: 11 }),
  clientId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{24}$" })),
  buildServices: Type.Optional(Type.Object({ buildkitSocket: absolutePath, registryAddress: registryAddressSchema })),
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
  if (connection.buildServices && connection.buildServices.buildkitSocket !== join(connection.socketDirectory, "buildkit.sock")) throw new Error("invalid shared Docker build service sockets");
  return connection;
}

/** Host Docker resolves names outside the app container's /etc/hosts. */
export function dockerRegistryAddress(connection: DockerRuntimeConnection): string {
  const address = connection.buildServices!.registryAddress;
  return connection.depth === 0 ? address.replace(registryHostname, "127.0.0.1") : address;
}
