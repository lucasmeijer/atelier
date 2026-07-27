import { describe, expect, test } from "bun:test";
import { workspaceImagePruneArgs } from "./prune.ts";

describe("workspace image pruning", () => {
  test("prunes only older unused Atelier images of the baked kind", () => {
    expect(workspaceImagePruneArgs("repository", new Date("2026-07-27T12:00:00.000Z"))).toEqual([
      "image", "prune", "--all", "--force",
      "--filter", "label=com.atelier.workspace-image.kind=repository",
      "--filter", "until=1785153600",
    ]);
  });
});
