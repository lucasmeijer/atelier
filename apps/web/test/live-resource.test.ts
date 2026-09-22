import { expect, test } from "bun:test";
import { createLiveResource } from "../src/server/live-resource.ts";

const reportError = (error: Error): never => { throw error; };

test("HTTP reads and subscription initialization share one committed load", async () => {
  let loads = 0;
  const resource = createLiveResource(async () => ({ value: ++loads }), () => [], reportError);
  expect(await resource.read()).toEqual({ value: 1 });
  const subscription = await resource.subscribe(() => {});
  subscription.unsubscribe();
  const reconnect = await resource.subscribe(() => {});
  expect(loads).toBe(1);
  expect(await resource.read()).toEqual({ value: 1 });
  reconnect.unsubscribe();
  resource.dispose();
});

test("invalidating an inactive resource supersedes its unfinished read", async () => {
  const first = Promise.withResolvers<number>();
  let loads = 0;
  const resource = createLiveResource(() => ++loads === 1 ? first.promise : Promise.resolve(2), () => [], reportError);
  const read = resource.read();
  resource.invalidate();
  first.resolve(1);
  expect(await read).toBe(2);
  expect(await resource.read()).toBe(2);
  expect(loads).toBe(2);
  resource.dispose();
});

test("invalidating an inactive committed value defers I/O until it is needed", async () => {
  let loads = 0;
  const resource = createLiveResource(async () => ++loads, () => [], reportError);
  expect(await resource.read()).toBe(1);
  resource.invalidate();
  expect(loads).toBe(1);
  expect(await resource.read()).toBe(2);
  resource.dispose();
});

test("disposing during an initial read rejects the reader instead of returning missing state", async () => {
  const load = Promise.withResolvers<number>();
  const resource = createLiveResource(() => load.promise, () => [], reportError);
  const read = resource.read();
  resource.dispose();
  load.resolve(1);
  await expect(read).rejects.toThrow("disposed");
});

test("invalidation between publication and the read continuation waits for fresh state", async () => {
  let loads = 0;
  const resource = createLiveResource(async () => ++loads, () => [], reportError);
  const read = resource.read();
  queueMicrotask(() => resource.invalidate());
  expect(await read).toBe(2);
  expect(await resource.read()).toBe(2);
  expect(loads).toBe(2);
  resource.dispose();
});
