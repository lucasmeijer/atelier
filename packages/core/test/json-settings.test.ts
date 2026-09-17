import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonSettings, updateJsonSettings } from "../src/json-settings.ts";

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atelier-json-settings-"));
  path = join(directory, "settings.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("concurrent owners preserve each other's keys and existing unknown settings", async () => {
  await writeFile(path, JSON.stringify({ olderSetting: { retained: true } }));
  await Promise.all(Array.from({ length: 20 }, (_, index) => updateJsonSettings(path, (settings) => {
    settings[`owner-${index}`] = index;
  })));
  const settings = await readJsonSettings(path);
  expect(settings.olderSetting).toEqual({ retained: true });
  for (let index = 0; index < 20; index++) expect(settings[`owner-${index}`]).toBe(index);
});

test("missing files start empty, while corrupt files are not overwritten", async () => {
  expect(await readJsonSettings(path)).toEqual({});
  await writeFile(path, "[1, 2]");
  await expect(updateJsonSettings(path, (settings) => { settings.changed = true; })).rejects.toThrow("must contain a JSON object");
  expect(await Bun.file(path).text()).toBe("[1, 2]");
});

test("failed updates do not commit and do not block subsequent updates", async () => {
  await expect(updateJsonSettings(path, (settings) => {
    settings.uncommitted = true;
    throw new Error("update failed");
  })).rejects.toThrow("update failed");
  await updateJsonSettings(path, (settings) => { settings.committed = true; });
  expect(await readJsonSettings(path)).toEqual({ committed: true });
});

test("an unchanged transaction does not create a settings file", async () => {
  await updateJsonSettings(path, () => false);
  expect(await Bun.file(path).exists()).toBe(false);
});
