import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { tailscaleDnsAddress } from "../../workspace-image/src/runtime-connection.ts";
import type { WorkspaceDockerPlan } from "./types.ts";

import { dockerRuntimeConnectionPath, dockerRuntimeConnectionSchema, type DockerRuntimeConnection } from "@atelier/workspace-image";
export { dockerRuntimeConnectionPath, readDockerRuntimeConnection, type DockerRuntimeConnection } from "@atelier/workspace-image";
const registrationSchema = Type.Object({ clientId: Type.String({ pattern: "^[a-f0-9]{24}$" }), connection: dockerRuntimeConnectionSchema });

async function optionalFile(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
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
  if (connection.buildServices) {
    // Both the private daemon and nested Atelier must reach the registry directly,
    // not through the workspace's secret-injecting outbound HTTP proxy.
    plan.extraArgs.push("--dns", tailscaleDnsAddress);
    const registryHost = connection.buildServices.registryAddress.split(":")[0]!;
    for (const key of ["NO_PROXY", "no_proxy"]) {
      plan.env[key] = [...new Set([...(plan.env[key]?.split(",") ?? []), registryHost])].join(",");
    }
  }
  const nested = { ...connection, depth: connection.depth + 1 };
  const source = join(directory, "connection.json");
  await writeFile(source, JSON.stringify(nested));
  plan.containerFiles.push({ source, target: dockerRuntimeConnectionPath });
  plan.sharedDocker = {
    snapshotterSocket: join(connection.socketDirectory, `${clientId}.sock`),
    snapshotterRoot: connection.snapshotterRoot,
    bridgeCIDR: `10.${231 + 2 * connection.depth}.0.1/24`,
    addressPool: `10.${232 + 2 * connection.depth}.0.0/16`,
    insecureRegistries: connection.buildServices ? [connection.buildServices.registryAddress] : [],
  };
}

export async function retireWorkspaceDocker(directory: string): Promise<void> {
  const text = await optionalFile(join(directory, "registration.json"));
  if (text === undefined) return;
  const registration = Value.Parse(registrationSchema, JSON.parse(text));
  await request(registration.connection, "retire", registration.clientId);
}
