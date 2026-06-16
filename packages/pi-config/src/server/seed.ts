import { existsSync } from "node:fs";
import { join } from "node:path";
import { AtelierCoreError, atelierDataPath, getAtelierRuntimeContext, runDocker, type AtelierEventBus } from "@atelier/core";
import { execWorkspaceCommand, workspaceContainerName } from "@atelier/workspace";

const workspacePiConfigDir = "/home/atelier/.pi/agent";
const seedFilenames = ["auth.json", "settings.json", "models.json"] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function piConfigSeedDir(): Promise<string> {
  const runtimeContext = await getAtelierRuntimeContext();
  return atelierDataPath(runtimeContext, "pi-config");
}

export async function seedWorkspacePiConfig(workspaceId: string): Promise<void> {
  const seedDir = await piConfigSeedDir();
  const existingFiles = seedFilenames.map((filename) => ({ filename, path: join(seedDir, filename) })).filter((file) => existsSync(file.path));
  if (existingFiles.length === 0) return;

  const prepared = await execWorkspaceCommand(
    workspaceId,
    ["sh", "-lc", `mkdir -p ${shellQuote(workspacePiConfigDir)} && chown -R atelier:atelier /home/atelier/.pi`],
    { user: "root" },
  );
  if (prepared.exitCode !== 0) {
    throw new AtelierCoreError("pi_config_seed_failed", prepared.stderr.trim() || prepared.stdout.trim() || `could not prepare pi config directory for ${workspaceId}`);
  }

  for (const file of existingFiles) {
    const copied = await runDocker(["cp", file.path, `${workspaceContainerName(workspaceId)}:${workspacePiConfigDir}/${file.filename}`]);
    if (copied.exitCode !== 0) {
      throw new AtelierCoreError("pi_config_seed_failed", copied.stderr.trim() || copied.stdout.trim() || `could not copy ${file.filename} into ${workspaceId}`);
    }
  }

  const owned = await execWorkspaceCommand(workspaceId, ["chown", "-R", "atelier:atelier", "/home/atelier/.pi"], { user: "root" });
  if (owned.exitCode !== 0) {
    throw new AtelierCoreError("pi_config_seed_failed", owned.stderr.trim() || owned.stdout.trim() || `could not set pi config ownership for ${workspaceId}`);
  }
}

export function registerPiConfigEvents(events: AtelierEventBus): void {
  events.on("workspace_created", async ({ workspaceId }) => {
    await seedWorkspacePiConfig(workspaceId);
  });
}
