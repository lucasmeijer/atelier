import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessFileLock } from "../src/file-lock.ts";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "atelier-file-lock-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("runs queued callbacks exclusively in FIFO order and returns their results", async () => {
  const withLock = createProcessFileLock({ lockDir: () => join(directory, "lock"), label: "test" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: number[] = [];
  let active = 0;
  const operations = [0, 1, 2].map((index) => withLock(async () => {
    expect(active++).toBe(0);
    order.push(index);
    if (index === 0) {
      entered.resolve();
      await release.promise;
    }
    active--;
    return index * 2;
  }));
  await entered.promise;
  expect(order).toEqual([0]);
  release.resolve();
  expect(await Promise.all(operations)).toEqual([0, 2, 4]);
  expect(order).toEqual([0, 1, 2]);
});

test("propagates lock acquisition failure and allows the next queued call", async () => {
  const blockedParent = join(directory, "file");
  await writeFile(blockedParent, "not a directory");
  let attempts = 0;
  const withLock = createProcessFileLock({
    lockDir: () => attempts++ === 0 ? join(blockedParent, "lock") : join(directory, "lock"),
    label: "test",
  });
  let called = false;
  const failure = withLock(async () => { called = true; });
  const next = withLock(async () => "next");
  await expect(failure).rejects.toBeInstanceOf(Error);
  expect(called).toBe(false);
  expect(await next).toBe("next");
});

test("propagates callback failure and allows the next queued call", async () => {
  const withLock = createProcessFileLock({ lockDir: () => join(directory, "lock"), label: "test" });
  const error = new Error("callback failed");
  const failure = withLock(async () => { throw error; });
  const next = withLock(async () => "next");
  await expect(failure).rejects.toBe(error);
  expect(await next).toBe("next");
});

test("propagates file lock release failure without stranding queued calls", async () => {
  const lockDir = join(directory, "lock");
  const withLock = createProcessFileLock({ lockDir: () => lockDir, label: "test" });
  const failure = withLock(async () => { await rmdir(lockDir); });
  const next = withLock(async () => "next");
  await expect(failure).rejects.toMatchObject({ code: "ENOENT" });
  expect(await next).toBe("next");
});
