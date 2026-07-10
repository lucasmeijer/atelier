import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WebPreferences {
  preferredNewAgentModel?: string;
}

export interface WebPreferenceStore {
  load(): Promise<WebPreferences>;
  save(preferences: WebPreferences): Promise<void>;
}

export function createFileWebPreferenceStore(path: string): WebPreferenceStore {
  async function load(): Promise<WebPreferences> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
      return parsed as WebPreferences;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  return {
    load,
    async save(preferences) {
      await mkdir(dirname(path), { recursive: true });
      const tempPath = `${path}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`);
      await rename(tempPath, path);
    },
  };
}
