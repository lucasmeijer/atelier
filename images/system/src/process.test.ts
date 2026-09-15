import { expect, test } from "bun:test";
import { command } from "./process.ts";

test("System command deadline terminates a stalled operation and reports its cause", async () => {
  await expect(command(["sleep", "10"], undefined, 20)).rejects.toThrow("Timed out after 0.02s: sleep 10");
});

test("a completed operation returns output before its deadline", async () => {
  expect(await command(["printf", "ready"], undefined, 1000)).toBe("ready");
});

test("one output callback supplies the raw stream for progress and logging", async () => {
  let output = "";
  expect(await command(["printf", "first\nsecond\n"], chunk => { output += chunk; })).toBe("first\nsecond");
  expect(output).toBe("first\nsecond\n");
});
