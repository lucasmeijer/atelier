import { expect, test } from "bun:test";
import { PullProgress } from "./pull-progress.ts";

test("tracks Docker layer discovery and extraction completion across stream chunks", () => {
  const progress = new PullProgress();
  expect(progress.push("abc: Pulling fs lay")).toBeUndefined();
  expect(progress.push("er\ndef: Already exists\nabc: Download complete\n")).toBe(50);
  expect(progress.push("abc: Pull complete\nabc: Pull complete\nDigest: sha256:abcd\n")).toBe(100);
});


test("each image starts without a percentage and discovery alone is zero progress", () => {
  const progress = new PullProgress();
  expect(progress.push("Pulling from atelier\n")).toBeUndefined();
  expect(progress.push("abc: Pulling fs layer\n")).toBe(0);
  expect(progress.push("abc: Pull complete\n")).toBe(100);
  expect(new PullProgress().push("")).toBeUndefined();
});
