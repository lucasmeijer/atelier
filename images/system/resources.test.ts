import { expect, test } from "bun:test";
import { resourcePolicy } from "./src/resources.ts";
const GiB = 1024 ** 3;
test("collective workloads leave management headroom on small and large Systems", () => {
  expect(resourcePolicy(3 * GiB, 4096)).toEqual({
    memory: 2 * GiB,
    memoryHigh: Math.floor(1.8 * GiB),
    reserve: GiB,
    pids: 3072,
  });
  expect(resourcePolicy(64 * GiB, Infinity)).toEqual({
    memory: 60 * GiB,
    memoryHigh: 54 * GiB,
    reserve: 4 * GiB,
    pids: 8192,
  });
  expect(resourcePolicy(8 * GiB, 4096).reserve).toBe(Math.ceil(1.6 * GiB));
});
test("reject constrained Systems rather than silently discarding protection", () => {
  expect(() => resourcePolicy(2 * GiB, 8192)).toThrow("3 GiB");
  expect(() => resourcePolicy(8 * GiB, 1024)).toThrow("2048");
});
