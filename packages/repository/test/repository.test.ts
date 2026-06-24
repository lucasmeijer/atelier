import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addRepository, getGitIdentity, gitIdentitySettingsFile, hasGitIdentity, listRepositories, parseRepositorySpec, setGitIdentity } from "@atelier/repository";

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

  test("git identity settings are stored by the repository module", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-repository-settings-")), "repository-settings.json");

    expect(await hasGitIdentity(file)).toBe(false);
    await setGitIdentity({ name: " Ada Lovelace ", email: " ada@example.com " }, file);

    expect(await hasGitIdentity(file)).toBe(true);
    expect(await getGitIdentity(file)).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  test("git identity adopts the host global git config when app settings are empty", async () => {
    const previousDataDir = process.env.ATELIER_DATA_DIR;
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-repository-settings-"));
    const gitConfig = join(await mkdtemp(join(tmpdir(), "atelier-git-config-")), ".gitconfig");
    process.env.ATELIER_DATA_DIR = dataDir;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    try {
      await writeFile(gitConfig, "[user]\n\tname = Grace Hopper\n\temail = grace@example.com\n", "utf8");

      expect(await getGitIdentity()).toEqual({ name: "Grace Hopper", email: "grace@example.com" });
      expect(JSON.parse(await readFile(gitIdentitySettingsFile(), "utf8"))).toEqual({ gitIdentity: { name: "Grace Hopper", email: "grace@example.com" } });
    } finally {
      if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previousDataDir;
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }
  });
});
