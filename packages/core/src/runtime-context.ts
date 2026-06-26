import { join } from "node:path";
import { defaultDataDir } from "./data-dir.ts";

export interface AtelierRuntimeContext {
  /** Path as seen by the Atelier process itself. Use this for normal Atelier file IO. */
  atelierDataDir: string;
  /** Same directory as seen by the Docker daemon. Use this for Docker bind mount sources. */
  dockerHostAtelierDataDir: string;
  /** Host-side Docker bridge IP used for Atelier/workspace traffic. */
  dockerBridgeHost: string;
}

let cachedRuntimeContext: AtelierRuntimeContext | undefined;
let cachedRuntimeContextKey: string | undefined;

export function atelierDataPath(context: AtelierRuntimeContext, ...segments: string[]): string {
  return join(context.atelierDataDir, ...segments);
}

export function dockerHostAtelierDataPath(context: AtelierRuntimeContext, ...segments: string[]): string {
  return join(context.dockerHostAtelierDataDir, ...segments);
}

export function getAtelierRuntimeContext(): AtelierRuntimeContext {
  const context = readRuntimeContextFromEnv();
  const key = runtimeContextKey(context);
  if (!cachedRuntimeContext || cachedRuntimeContextKey !== key) {
    cachedRuntimeContext = context;
    cachedRuntimeContextKey = key;
  }
  return cachedRuntimeContext;
}

export function resetAtelierRuntimeContextForTests(): void {
  cachedRuntimeContext = undefined;
  cachedRuntimeContextKey = undefined;
}

export function discoverAtelierRuntimeContext(): AtelierRuntimeContext {
  return readRuntimeContextFromEnv();
}

function readRuntimeContextFromEnv(): AtelierRuntimeContext {
  const atelierDataDir = envString("ATELIER_DATA_DIR") ?? defaultDataDir();
  return {
    atelierDataDir,
    dockerHostAtelierDataDir: envString("ATELIER_DOCKER_HOST_DATA_DIR") ?? atelierDataDir,
    dockerBridgeHost: inspectDockerBridgeHost(),
  };
}

function runtimeContextKey(context: AtelierRuntimeContext): string {
  return [
    context.atelierDataDir,
    context.dockerHostAtelierDataDir,
    context.dockerBridgeHost,
  ].join("\0");
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function inspectDockerBridgeHost(): string {
  const result = Bun.spawnSync(["docker", "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`could not inspect Docker bridge gateway: ${new TextDecoder().decode(result.stderr).trim()}`);
  const host = new TextDecoder().decode(result.stdout).trim();
  if (!host) throw new Error("Docker bridge gateway is empty");
  return host;
}
