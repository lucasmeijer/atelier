import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultDataDir } from "@atelier/core";
import { isReleaseChannel, type ReleaseChannel } from "./channels.ts";

function settingsPath(): string {
  return join(process.env.ATELIER_DATA_DIR?.trim() || defaultDataDir(), "update.json");
}

export async function readStoredReleaseChannel(): Promise<ReleaseChannel | undefined> {
  const text = await readFile(settingsPath(), "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!(parsed instanceof Object) || !("releaseChannel" in parsed) || parsed.releaseChannel === undefined) return undefined;
  const releaseChannel = parsed.releaseChannel;
  if (typeof releaseChannel !== "string" || !isReleaseChannel(releaseChannel)) throw new Error(`unsupported release channel in update settings: ${releaseChannel}`);
  return releaseChannel;
}

export async function writeStoredReleaseChannel(channel: ReleaseChannel): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ releaseChannel: channel }, null, 2)}\n`);
  await rename(tempPath, path);
}
