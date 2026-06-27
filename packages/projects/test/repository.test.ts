import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { addProject, getGitIdentity, gitIdentitySettingsFile, hasGitIdentity, listProjects, parseProjectSpec, setGitIdentity } from "@atelier/projects";

describe("projects", () => {
  test("parseProjectSpec supports an optional #branch suffix", () => {
    expect(parseProjectSpec("https://github.com/org/repo.git#main")).toEqual({ gitUrl: "https://github.com/org/repo.git", branch: "main" });
    expect(parseProjectSpec("git@github.com:org/repo.git")).toEqual({ gitUrl: "git@github.com:org/repo.git", branch: null });
  });

  test("addProject records a remote URL without cloning it", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-projects-")), "projects.json");

    const result = await addProject("https://github.com/org/repo.git#feature", file);
    expect(result.project.name).toBe("repo");
    expect(result.project.gitUrl).toBe("https://github.com/org/repo.git");
    expect(result.project.branch).toBe("feature");

    expect(await listProjects(file)).toEqual({ projects: [result.project] });
  });

  test("git identity settings are stored by the projects module", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "atelier-project-settings-")), "project-settings.json");

    expect(await hasGitIdentity(file)).toBe(false);
    await setGitIdentity({ name: " Ada Lovelace ", email: " ada@example.com " }, file);

    expect(await hasGitIdentity(file)).toBe(true);
    expect(await getGitIdentity(file)).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  test("git identity adopts the host global git config when app settings are empty", async () => {
    const previousDataDir = process.env.ATELIER_DATA_DIR;
    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-project-settings-"));
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
