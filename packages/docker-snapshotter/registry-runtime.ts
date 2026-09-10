import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject, type JsonObject, type JsonValue } from "@atelier/core";
import { defaultTailscaleLocalApiSocketPath, mutateTailscaleServeConfig, tailscaleLocalApiRequest, type TailscaleServeConfig } from "../proxy-ingress/src/ingress/tailscale-serve.ts";
import { registryAddressSchema } from "../workspace-image/src/runtime-connection.ts";

// Outside the HTTPS preview port range. The same port is used on loopback and Serve.
const registryPortSchema = Type.Integer({ minimum: 42000, maximum: 42999 });
const statusSchema = Type.Object({ BackendState: Type.Literal("Running"), Self: Type.Object({ DNSName: Type.String() }) });

function forward(port: number) { return { TCPForward: `127.0.0.1:${port}` }; }
function ownsForward(value: JsonValue | undefined, port: number): boolean {
  return isJsonObject(value) && Object.keys(value).length === 1 && value.TCPForward === forward(port).TCPForward;
}

export function ensureRegistryForward(config: TailscaleServeConfig, port: number): boolean {
  Value.Parse(registryPortSchema, port);
  if (isJsonObject(config.AllowFunnel) && Object.entries(config.AllowFunnel).some(([key, allowed]) => key.endsWith(`:${port}`) && allowed === true)) throw new Error("registry port must not be exposed through Tailscale Funnel");
  const currentTcp = config.TCP;
  if (currentTcp !== undefined && !isJsonObject(currentTcp)) throw new Error("Tailscale Serve TCP config is not an object");
  const tcp: JsonObject = currentTcp ?? {};
  config.TCP = tcp;
  const current = tcp[String(port)];
  if (ownsForward(current, port)) return false;
  if (current !== undefined || isJsonObject(config.Web) && Object.keys(config.Web).some(key => key.endsWith(`:${port}`))) throw new Error(`registry Serve port ${port} belongs to another service`);
  tcp[String(port)] = forward(port);
  return true;
}

export function removeRegistryForward(config: TailscaleServeConfig, port: number): boolean {
  if (!isJsonObject(config.TCP) || !ownsForward(config.TCP[String(port)], port)) return false;
  delete config.TCP[String(port)];
  if (Object.keys(config.TCP).length === 0) delete config.TCP;
  return true;
}

function allocateRegistryPort(config: TailscaleServeConfig): number {
  for (let port = 42000; port <= 42999; port++) {
    if (isJsonObject(config.TCP) && config.TCP[String(port)] !== undefined) continue;
    if (isJsonObject(config.Web) && Object.keys(config.Web).some(key => key.endsWith(`:${port}`))) continue;
    if (isJsonObject(config.AllowFunnel) && Object.keys(config.AllowFunnel).some(key => key.endsWith(`:${port}`))) continue;
    try {
      const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
      listener.stop(true);
      return port;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    }
  }
  throw new Error("no unused loopback/Serve registry port in 42000-42999");
}

async function readPort(runtime: string): Promise<number> {
  return Value.Parse(registryPortSchema, JSON.parse(await readFile(join(runtime, "registry-port"), "utf8")));
}

/** Called by the installation owner, under its lifetime lock. No host Docker changes. */
export async function prepareRegistry(runtime: string, socket = defaultTailscaleLocalApiSocketPath): Promise<string> {
  const status = Value.Parse(statusSchema, JSON.parse(await tailscaleLocalApiRequest(socket, "GET", "/localapi/v0/status")));
  const host = status.Self.DNSName.replace(/\.$/, "").toLowerCase();
  Value.Parse(registryAddressSchema, `${host}:42000`);
  const path = join(runtime, "registry-port");
  let port = await Bun.file(path).exists() ? await readPort(runtime) : undefined;
  await mutateTailscaleServeConfig(socket, async config => {
    if (port === undefined) {
      port = allocateRegistryPort(config);
      await writeFile(`${path}.tmp`, `${port}\n`, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    }
    return ensureRegistryForward(config, port);
  });
  return `${host}:${port}`;
}

export async function releaseRegistry(runtime: string, socket = defaultTailscaleLocalApiSocketPath): Promise<void> {
  const port = await readPort(runtime);
  await mutateTailscaleServeConfig(socket, config => removeRegistryForward(config, port));
}

if (import.meta.main) {
  const [command, runtime] = process.argv.slice(2);
  if (!runtime || process.argv.length !== 4) throw new Error("usage: registry-runtime.ts prepare|release <runtime>");
  if (command === "prepare") console.log(await prepareRegistry(runtime));
  else if (command === "release") await releaseRegistry(runtime);
  else throw new Error(`unknown registry runtime command: ${command}`);
}
