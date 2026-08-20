import { describe, expect, test } from "bun:test";
import { createSerializedImageTagger } from "./tag-queue.ts";

describe("serialized image tagging", () => {
  test("runs concurrent tag requests one at a time", async () => {
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const completed: string[] = [];
    const tag = createSerializedImageTagger(async (baseImage) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (baseImage === "first") {
        markFirstStarted();
        await firstRelease;
      }
      completed.push(baseImage);
      active -= 1;
    });

    const first = tag("first");
    await firstStarted;
    const second = tag("second");
    const third = tag("third");
    await Promise.resolve();
    expect(active).toBe(1);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(maximumActive).toBe(1);
    expect(completed).toEqual(["first", "second", "third"]);
  });

  test("continues after a failed tag request", async () => {
    const completed: string[] = [];
    const tag = createSerializedImageTagger(async (baseImage) => {
      if (baseImage === "broken") throw new Error("tag failed");
      completed.push(baseImage);
    });

    await expect(tag("broken")).rejects.toThrow("tag failed");
    await tag("working");
    expect(completed).toEqual(["working"]);
  });
});
