import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultDataDir } from "@atelier/core";
import { isReleaseChannel, type ReleaseChannel } from "./channels.ts";

interface UpdateSettingsFile { releaseChannel?: string }

function settingsPath(): string {
  return join(process.env.ATELIER_DATA_DIR?.trim() || defaultDataDir(), "update.json");
}

export async function readStoredReleaseChannel(): Promise<ReleaseChannel | undefined> {
  const text = await readFile(settingsPath(), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return undefined;
  const parsed = JSON.parse(text) as UpdateSettingsFile;
  if (parsed.releaseChannel === undefined) return undefined;
  if (!isReleaseChannel(parsed.releaseChannel)) throw new Error(`unsupported release channel in update settings: ${parsed.releaseChannel}`);
  return parsed.releaseChannel;
}

export async function writeStoredReleaseChannel(channel: ReleaseChannel): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ releaseChannel: channel }, null, 2)}\n`);
}
