import { describe, expect, test } from "bun:test";
import { createKeyedOperationQueue } from "../src/keyed-operation-queue.ts";

describe("keyed operation queue", () => {
  test("serializes the same key without blocking a different key", async () => {
    const run = createKeyedOperationQueue();
    const gate = Promise.withResolvers<void>();
    const started: string[] = [];
    const first = run("a", async () => {
      started.push("first");
      await gate.promise;
      return 1;
    });
    const second = run("a", async () => {
      started.push("second");
      return 2;
    });
    const other = run("b", async () => {
      started.push("other");
      return 3;
    });
    expect(await other).toBe(3);
    expect(started).toEqual(["first", "other"]);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(started).toEqual(["first", "other", "second"]);
  });

  test("propagates failure and continues with queued and subsequent operations", async () => {
    const run = createKeyedOperationQueue();
    const error = new Error("failed");
    const failed = run("a", async () => { throw error; });
    const next = run("a", async () => 2);
    expect(await failed.catch((caught) => caught)).toBe(error);
    expect(await next).toBe(2);
    expect(await run("a", async () => 3)).toBe(3);
  });

  test("keeps independent queue instances isolated", async () => {
    const firstQueue = createKeyedOperationQueue();
    const secondQueue = createKeyedOperationQueue();
    const gate = Promise.withResolvers<void>();
    const pending = firstQueue("same-key", async () => await gate.promise);
    expect(await secondQueue("same-key", async () => "ready")).toBe("ready");
    gate.resolve();
    await pending;
  });
});
