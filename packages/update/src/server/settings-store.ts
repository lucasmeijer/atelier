import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultDataDir } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { releaseChannelSchema, type ReleaseChannel } from "./channels.ts";

const updateSettingsSchema = Type.Object({
  releaseChannel: Type.Optional(releaseChannelSchema),
});

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
  if (!Value.Check(updateSettingsSchema, parsed)) throw new Error("invalid update settings");
  return parsed.releaseChannel;
}

export async function writeStoredReleaseChannel(channel: ReleaseChannel): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ releaseChannel: channel }, null, 2)}\n`);
  await rename(tempPath, path);
}
