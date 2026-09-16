import { expect, test } from "bun:test";
import { PullProgress } from "./pull-progress.ts";

test("tracks Docker layer discovery and extraction completion across stream chunks", () => {
  const progress = new PullProgress();
  expect(progress.push("abc: Pulling fs lay")).toBeUndefined();
  expect(progress.push("er\ndef: Already exists\nabc: Download complete\n")).toEqual({ completed: 1, total: 2 });
  expect(progress.push("abc: Pull complete\nabc: Pull complete\nDigest: sha256:abcd\n")).toEqual({ completed: 2, total: 2 });
});


test("each image starts without counts and discovery alone completes no layers", () => {
  const progress = new PullProgress();
  expect(progress.push("Pulling from atelier\n")).toBeUndefined();
  expect(progress.push("abc: Pulling fs layer\n")).toEqual({ completed: 0, total: 1 });
  expect(progress.push("abc: Pull complete\n")).toEqual({ completed: 1, total: 1 });
  expect(new PullProgress().push("")).toBeUndefined();
});
