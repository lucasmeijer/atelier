import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { addManagedRepo, listManagedRepos } from "../src/managed-repo.ts";

async function git(args: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed\n${stdout}\n${stderr}`);
}

describe("managed repos", () => {
  test("listManagedRepos lists bare repos and skips worktrees", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-managed-repos-"));
    await git(["init", "--bare", join(dir, "bare.git")]);
    await git(["init", join(dir, "worktree")]);

    const result = await listManagedRepos(dir);

    expect(result.repos.map((repo) => repo.name)).toEqual(["bare.git"]);
  });

  test("addManagedRepo creates a bare clone", async () => {
    const source = await mkdtemp(join(tmpdir(), "atelier-managed-source-"));
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-managed-data-"));
    await git(["init"], source);
    await git(["config", "user.name", "Test"], source);
    await git(["config", "user.email", "test@example.invalid"], source);
    await writeFile(join(source, "README.md"), "hello\n");
    await git(["add", "README.md"], source);
    await git(["commit", "-m", "initial"], source);

    const result = await addManagedRepo(source, dataDir);

    expect(result.repo.name).toBe(`${source.split("/").at(-1)}.git`);
    expect(result.repo.remoteUrl).toBe(source);
    const listed = await listManagedRepos(dataDir);
    expect(listed.repos).toContainEqual(result.repo);
  });
});
