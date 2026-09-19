import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

// The app owns this persisted setting. System reads it independently so recovery
// never requires a functioning app or a second, potentially stale channel setting.
const settingsSchema = Type.Object({
  releaseChannel: Type.Optional(Type.Union([Type.Literal("stable"), Type.Literal("latest")])),
});

export async function prepareChannelUpdate(settingsPath: string, images: {
  pull: (reference: string) => Promise<void>;
  inspect: (reference: string) => Promise<string>;
}): Promise<string> {
  const text = await readFile(settingsPath, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  const settings: unknown = text === undefined ? {} : JSON.parse(text);
  if (!Value.Check(settingsSchema, settings)) throw new Error("Invalid update settings");
  const reference = `ghcr.io/lucasmeijer/atelier:${settings.releaseChannel ?? "stable"}`;
  // Always refresh the mutable channel tag, even if Docker already has it.
  // Pin the result before dependencies are prepared or the app is stopped.
  await images.pull(reference);
  return await images.inspect(reference);
}
