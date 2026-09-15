import { expect, test } from "bun:test";
import { command } from "./process.ts";

test("System command deadline terminates a stalled operation and reports its cause", async () => {
  await expect(command(["sleep", "10"], undefined, undefined, 20)).rejects.toThrow("Timed out after 0.02s: sleep 10");
});

test("a completed operation returns output before its deadline", async () => {
  expect(await command(["printf", "ready"], undefined, undefined, 1000)).toBe("ready");
});
