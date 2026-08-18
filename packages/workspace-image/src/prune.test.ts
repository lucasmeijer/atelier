import { describe, expect, test } from "bun:test";
import { workspaceImagePruneArgs } from "./prune.ts";

describe("workspace image pruning", () => {
  test("prunes only images created before the build's second", () => {
    expect(workspaceImagePruneArgs("repository", new Date("2026-07-27T12:00:00.789Z"))).toEqual([
      "image", "prune", "--all", "--force",
      "--filter", "label=com.atelier.workspace-image.kind=repository",
      "--filter", "until=1785153599",
    ]);
  });
});
