import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareChannelUpdate } from "./channel-update.ts";

let directory: string;
let settingsPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atelier-channel-update-"));
  settingsPath = join(directory, "update.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function imageOperations() {
  return {
    pull: mock(async (_reference: string) => {}),
    inspect: mock(async (_reference: string) => "sha256:resolved-app"),
  };
}

test("missing update settings selects stable", async () => {
  const images = imageOperations();
  expect(await prepareChannelUpdate(settingsPath, images)).toBe("sha256:resolved-app");
  expect(images.pull).toHaveBeenCalledWith("ghcr.io/lucasmeijer/atelier:stable");
  expect(images.inspect).toHaveBeenCalledWith("ghcr.io/lucasmeijer/atelier:stable");
});

test.each([
  ["{}", "stable"],
  ['{"releaseChannel":"stable"}', "stable"],
  ['{"releaseChannel":"latest"}', "latest"],
  ['{"releaseChannel":"latest","ignoredSetting":true}', "latest"],
])("settings %s select %s", async (settings, channel) => {
  await writeFile(settingsPath, settings);
  const images = imageOperations();
  await prepareChannelUpdate(settingsPath, images);
  expect(images.pull).toHaveBeenCalledWith(`ghcr.io/lucasmeijer/atelier:${channel}`);
  expect(images.inspect).toHaveBeenCalledWith(`ghcr.io/lucasmeijer/atelier:${channel}`);
});

test("reads channel again for each update", async () => {
  const images = imageOperations();
  await writeFile(settingsPath, '{"releaseChannel":"stable"}');
  await prepareChannelUpdate(settingsPath, images);
  await writeFile(settingsPath, '{"releaseChannel":"latest"}');
  await prepareChannelUpdate(settingsPath, images);
  expect(images.pull.mock.calls).toEqual([
    ["ghcr.io/lucasmeijer/atelier:stable"],
    ["ghcr.io/lucasmeijer/atelier:latest"],
  ]);
});

test.each([
  "{",
  "null",
  "[]",
  '"stable"',
  '{"releaseChannel":"nightly"}',
  '{"releaseChannel":null}',
  '{"releaseChannel":7}',
])("invalid settings %s fail without pulling or inspecting", async (settings) => {
  await writeFile(settingsPath, settings);
  const images = imageOperations();
  await expect(prepareChannelUpdate(settingsPath, images)).rejects.toThrow();
  expect(images.pull).not.toHaveBeenCalled();
  expect(images.inspect).not.toHaveBeenCalled();
});

test("settings read errors other than missing file propagate without pulling", async () => {
  const images = imageOperations();
  await expect(prepareChannelUpdate(directory, images)).rejects.toThrow();
  expect(images.pull).not.toHaveBeenCalled();
  expect(images.inspect).not.toHaveBeenCalled();
});

test("pull failures propagate without inspecting a potentially stale local image", async () => {
  const failure = new Error("Registry unavailable");
  const images = imageOperations();
  images.pull.mockImplementation(async () => { throw failure; });
  await expect(prepareChannelUpdate(settingsPath, images)).rejects.toBe(failure);
  expect(images.inspect).not.toHaveBeenCalled();
});

test("always completes a fresh pull before inspecting and returns the exact image ID", async () => {
  const events: string[] = [];
  let revision = 0;
  const images = {
    pull: async (reference: string) => {
      events.push(`pull:${reference}`);
      await Promise.resolve();
      revision += 1;
      events.push(`pulled:${revision}`);
    },
    inspect: async (reference: string) => {
      events.push(`inspect:${reference}`);
      return `sha256:revision-${revision}`;
    },
  };
  expect(await prepareChannelUpdate(settingsPath, images)).toBe("sha256:revision-1");
  expect(await prepareChannelUpdate(settingsPath, images)).toBe("sha256:revision-2");
  expect(events).toEqual([
    "pull:ghcr.io/lucasmeijer/atelier:stable",
    "pulled:1",
    "inspect:ghcr.io/lucasmeijer/atelier:stable",
    "pull:ghcr.io/lucasmeijer/atelier:stable",
    "pulled:2",
    "inspect:ghcr.io/lucasmeijer/atelier:stable",
  ]);
});

test("inspect failures propagate", async () => {
  const failure = new Error("Image inspection failed");
  const images = imageOperations();
  images.inspect.mockImplementation(async () => { throw failure; });
  await expect(prepareChannelUpdate(settingsPath, images)).rejects.toBe(failure);
  expect(images.pull).toHaveBeenCalledTimes(1);
});
