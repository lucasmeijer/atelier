import { describe, expect, test } from "bun:test";
import { processExitMessage } from "../../src/server/process-diagnostics.ts";

describe("processExitMessage", () => {
  test("explains known NeMo Speech exit codes and includes stderr", () => {
    expect(processExitMessage("NeMo Speech", 2, "serve: unknown option: --example\n")).toBe(
      "NeMo Speech exited with code 2 (invalid argument or configuration):\nserve: unknown option: --example",
    );
  });

  test("preserves an unknown exit code without guessing", () => {
    expect(processExitMessage("NeMo Speech", 137, "")).toBe("NeMo Speech exited with code 137");
  });
});
