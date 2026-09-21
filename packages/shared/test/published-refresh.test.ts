import { expect, test } from "bun:test";
import { createPublishedRefresh } from "../src/live-presentation.ts";

test("overlapping refresh requests discard stale data and publish the latest once", async () => {
  const first = Promise.withResolvers<number>();
  const values: number[] = [];
  let calls = 0;
  const refresh = createPublishedRefresh(() => ++calls === 1 ? first.promise : Promise.resolve(2), value => values.push(value));
  const a = refresh.refresh();
  const b = refresh.refresh();
  first.resolve(1);
  await Promise.all([a, b]);
  expect(values).toEqual([2]);
  expect(calls).toBe(2);
});

test("disposing an owner prevents late I/O from resurrecting its state", async () => {
  const result = Promise.withResolvers<number>();
  const values: number[] = [];
  const refresh = createPublishedRefresh(() => result.promise, value => values.push(value));
  const pending = refresh.refresh();
  refresh.dispose();
  result.resolve(1);
  await pending;
  expect(values).toEqual([]);
  expect(() => refresh.refresh()).toThrow("disposed");
});

test("failed reads reject all joined callers, and a later explicit refresh can succeed", async () => {
  let fail = true;
  const values: number[] = [];
  const refresh = createPublishedRefresh(async () => { if (fail) throw new Error("read failed"); return 3; }, value => values.push(value));
  await expect(refresh.refresh()).rejects.toThrow("read failed");
  expect(values).toEqual([]);
  fail = false;
  await refresh.refresh();
  expect(values).toEqual([3]);
});

test("invalidation supersedes an in-flight read without starting a concurrent read", async () => {
  const first = Promise.withResolvers<number>();
  const values: number[] = [];
  let calls = 0;
  const refresh = createPublishedRefresh(() => ++calls === 1 ? first.promise : Promise.resolve(2), value => values.push(value));
  const pending = refresh.refresh();
  refresh.invalidate();
  expect(calls).toBe(1);
  first.resolve(1);
  await pending;
  expect(values).toEqual([2]);
});
