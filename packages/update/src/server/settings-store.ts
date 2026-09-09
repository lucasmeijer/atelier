import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { releaseChannelSchema, type ReleaseChannel } from "./channels.ts";

const settingsSchema = Type.Object({ releaseChannel: Type.Optional(releaseChannelSchema) });

function settingsPath(): string {
  return atelierDataPath(getAtelierRuntimeContext(), "update.json");
}

export async function readStoredReleaseChannel(): Promise<ReleaseChannel | undefined> {
  const text = await readFile(settingsPath(), "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(settingsSchema, parsed)) throw new Error("Invalid update settings");
  return parsed.releaseChannel;
}

export async function writeStoredReleaseChannel(channel: ReleaseChannel): Promise<void> {
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ releaseChannel: channel }, null, 2)}\n`);
}
