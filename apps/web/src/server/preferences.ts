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
      return parsed && typeof parsed === "object" ? parsed as WebPreferences : {};
    } catch {
      return {};
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
