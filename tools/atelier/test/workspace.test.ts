import { describe, expect, test } from "bun:test";
import { expectFailure, expectSuccess, runAtelier, type WorkspaceListResult } from "./helpers.ts";

describe("atelier workspace cli", () => {
  test("workspace list returns a JSON success response", async () => {
    const result = expectSuccess<WorkspaceListResult>(await runAtelier(["workspace", "list"]));

    expect(result).toEqual({ workspaces: [] });
  });

  test("workspace command errors are returned as JSON failures", async () => {
    const error = expectFailure(await runAtelier(["workspace", "list", "unexpected"]));

    expect(error.code).toBe("invalid_arguments");
  });
});
