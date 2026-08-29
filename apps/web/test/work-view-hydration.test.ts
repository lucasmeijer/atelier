import { expect, test } from "bun:test";
import { hydrateWorkViewFrame } from "../src/client/work-view-hydration.ts";

function workViewFrame(firstLoad: () => Promise<void>, reload: () => Promise<void>): HTMLElement & { loading: string } {
  const frame = Object.assign(Object.create(null), {
    loaded: Promise.resolve(),
    reload,
  });
  let loading = "lazy";
  Object.defineProperty(frame, "loading", {
    get: () => loading,
    set: (value: string) => {
      loading = value;
      frame.loaded = firstLoad();
    },
  });
  return frame;
}

test("Work view hydration makes the lazy load eager without reloading it", async () => {
  let reloads = 0;
  const frame = workViewFrame(() => Promise.resolve(), () => {
    reloads += 1;
    return Promise.resolve();
  });

  await expect(hydrateWorkViewFrame(frame)).resolves.toBeUndefined();

  expect(frame.loading).toBe("eager");
  expect(reloads).toBe(0);
});

test("failed Work view hydration rejects and remains retryable", async () => {
  const failure = new Error("Could not hydrate Work view");
  let reloads = 0;
  const frame = workViewFrame(() => Promise.reject(failure), () => {
    reloads += 1;
    return Promise.resolve();
  });

  await expect(hydrateWorkViewFrame(frame)).rejects.toBe(failure);
  await expect(hydrateWorkViewFrame(frame)).resolves.toBeUndefined();

  expect(frame.loading).toBe("eager");
  expect(reloads).toBe(1);
});
