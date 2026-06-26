import { join } from "node:path";
import { defaultDataDir } from "./data-dir.ts";

export interface AtelierRuntimeContext {
  /** Path as seen by the Atelier process itself. Use this for normal Atelier file IO. */
  atelierDataDir: string;
  /** Same directory as seen by the Docker daemon. Use this for Docker bind mount sources. */
  dockerHostAtelierDataDir: string;
  /** Host/IP where Docker publishes workspace ports, as seen by Atelier. */
  workspacePortHostFromAtelier: string;
  /** Host/IP workspace containers use to reach Atelier. */
  atelierHostFromWorkspace: string;
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
  const key = runtimeContextKey();
  if (!cachedRuntimeContext || cachedRuntimeContextKey !== key) {
    cachedRuntimeContext = discoverAtelierRuntimeContext();
    cachedRuntimeContextKey = key;
  }
  return cachedRuntimeContext;
}

export function resetAtelierRuntimeContextForTests(): void {
  cachedRuntimeContext = undefined;
  cachedRuntimeContextKey = undefined;
}

export function discoverAtelierRuntimeContext(): AtelierRuntimeContext {
  const atelierDataDir = envString("ATELIER_DATA_DIR") ?? defaultDataDir();
  return {
    atelierDataDir,
    dockerHostAtelierDataDir: envString("ATELIER_DOCKER_HOST_DATA_DIR") ?? atelierDataDir,
    workspacePortHostFromAtelier: envString("ATELIER_WORKSPACE_PORT_HOST_FROM_ATELIER") ?? "127.0.0.1",
    atelierHostFromWorkspace: envString("ATELIER_HOST_FROM_WORKSPACE") ?? "host.docker.internal",
  };
}

function runtimeContextKey(): string {
  return [
    envString("ATELIER_DATA_DIR") ?? "",
    envString("ATELIER_DOCKER_HOST_DATA_DIR") ?? "",
    envString("ATELIER_WORKSPACE_PORT_HOST_FROM_ATELIER") ?? "",
    envString("ATELIER_HOST_FROM_WORKSPACE") ?? "",
  ].join("\0");
}

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
