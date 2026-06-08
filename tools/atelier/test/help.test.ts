import { expect, test } from "bun:test";
import { runAtelier } from "./helpers.ts";

test("--help prints usage", async () => {
  const result = await runAtelier(["--help"]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("atelier [--help]");
  expect(result.stdout).toContain("-h, --help");
  expect(result.stdout).not.toContain("ATELIER_NAMESPACE");
});
