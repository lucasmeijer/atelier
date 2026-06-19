import { atelierDataPath, getAtelierRuntimeContext, type AtelierEventBus } from "@atelier/core";

export async function piConfigSeedDir(): Promise<string> {
  const runtimeContext = await getAtelierRuntimeContext();
  return atelierDataPath(runtimeContext, "pi-config");
}

export async function seedWorkspacePiConfig(_workspaceId: string): Promise<void> {
  // Atelier no longer copies host pi configuration into workspace containers.
}

export function registerPiConfigEvents(_events: AtelierEventBus): void {
  // Agent/runtime configuration is read by the Atelier server from the
  // authoritative file-backed settings, not seeded into command-line pi.
}
