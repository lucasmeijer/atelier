import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createKeyedOperationQueue } from "./keyed-operation-queue.ts";
import { isJsonObject } from "./json-request.ts";
import type { JsonObject } from "./json.ts";

const serialize = createKeyedOperationQueue();

export async function readJsonSettings(path: string): Promise<JsonObject> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isJsonObject(value)) throw new Error(`${path} must contain a JSON object`);
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function updateJsonSettings(path: string, update: (settings: JsonObject) => void | false): Promise<void> {
  await serialize(path, async () => {
    const settings = await readJsonSettings(path);
    if (update(settings) === false) return;
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temporary, path);
  });
}
