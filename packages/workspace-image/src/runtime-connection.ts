import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const dockerRuntimeConnectionPath = "/.atelier/docker-runtime.json";
const absolutePath = Type.String({ pattern: "^/[^\\r\\n,]*$" });
const dnsLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const port = "(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
// MagicDNS, never a persisted Tailscale IP. Serve and loopback use the same port.
export const registryAddressSchema = Type.String({ pattern: `^${dnsLabel}\\.${dnsLabel}\\.ts\\.net:${port}$` });
export const tailscaleDnsAddress = "100.100.100.100";

export function loopbackRegistryAddress(address: string): string {
  return `127.0.0.1:${address.split(":")[1]}`;
}

export function dockerRegistryAddress(connection: DockerRuntimeConnection): string {
  const address = connection.buildServices!.registryAddress;
  return connection.depth === 0 ? loopbackRegistryAddress(address) : address;
}

export const dockerRuntimeConnectionSchema = Type.Object({
  version: Type.Literal(1), adminSocket: absolutePath, snapshotterRoot: absolutePath,
  socketDirectory: absolutePath, depth: Type.Integer({ minimum: 0, maximum: 11 }),
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
