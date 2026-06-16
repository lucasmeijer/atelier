import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addRepository, listRepositories, parseRepositorySpec } from "@atelier/repository";

describe("repositories", () => {
  test("parseRepositorySpec supports an optional #branch suffix", () => {
    expect(parseRepositorySpec("https://github.com/org/repo.git#main")).toEqual({ gitUrl: "https://github.com/org/repo.git", branch: "main" });
    expect(parseRepositorySpec("git@github.com:org/repo.git")).toEqual({ gitUrl: "git@github.com:org/repo.git", branch: null });
  });

  test("addRepository records a remote URL without cloning it", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-repositories-")), "repositories.json");

    const result = await addRepository("https://github.com/org/repo.git#feature", file);
    expect(result.repo.name).toBe("repo");
    expect(result.repo.gitUrl).toBe("https://github.com/org/repo.git");
    expect(result.repo.branch).toBe("feature");

    expect(await listRepositories(file)).toEqual({ repos: [result.repo] });
  });
});
