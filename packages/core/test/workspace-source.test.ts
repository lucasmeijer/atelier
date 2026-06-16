import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareWorkspaceSource } from "@atelier/repository";

async function run(command: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr || stdout}`);
  return { stdout, stderr, exitCode };
}

async function createRemote(): Promise<{ root: string; remote: string; seed: string }> {
  const root = await mkdtemp(join(tmpdir(), "atelier-source-test-"));
  const seed = join(root, "seed");
  const remote = join(root, "repo.git");
  await run(["git", "init", "-b", "main", seed]);
  await run(["git", "config", "user.name", "Test"], { cwd: seed });
  await run(["git", "config", "user.email", "test@example.com"], { cwd: seed });
  await writeFile(join(seed, "file.txt"), "one\n");
  await run(["git", "add", "file.txt"], { cwd: seed });
  await run(["git", "commit", "-m", "one"], { cwd: seed });
  await run(["git", "clone", "--bare", seed, remote]);
  await run(["git", "remote", "add", "origin", remote], { cwd: seed });
  return { root, remote, seed };
}

describe("workspace source preparation", () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), "atelier-data-test-"));
    tempRoots.push(dataDir);
    process.env.ATELIER_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  test("creates a standalone COW workspace checkout from a reusable template", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);

    const source = await prepareWorkspaceSource({ workspaceId: "ws1", gitUrl: fixture.remote, branch: "main" });

    expect(await Bun.file(join(source.worktreePath, "file.txt")).text()).toBe("one\n");
    expect(source.cleanupPath).toBe(join(dataDir, "workspaces", "ws1"));
    const commonDir = (await run(["git", "-C", source.worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
    expect(await realpath(commonDir)).toBe(await realpath(join(source.worktreePath, ".git")));
    expect(await Bun.file(join(source.worktreePath, ".git", "objects", "info", "alternates")).exists()).toBe(false);
  });

  test("updates the template for later workspaces without changing existing workspaces", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);

    const first = await prepareWorkspaceSource({ workspaceId: "ws1", gitUrl: fixture.remote, branch: "main" });
    await writeFile(join(fixture.seed, "file.txt"), "two\n");
    await run(["git", "add", "file.txt"], { cwd: fixture.seed });
    await run(["git", "commit", "-m", "two"], { cwd: fixture.seed });
    await run(["git", "push", "origin", "main"], { cwd: fixture.seed });

    const second = await prepareWorkspaceSource({ workspaceId: "ws2", gitUrl: fixture.remote, branch: "main" });

    expect(await Bun.file(join(first.worktreePath, "file.txt")).text()).toBe("one\n");
    expect(await Bun.file(join(second.worktreePath, "file.txt")).text()).toBe("two\n");
    expect(first.resolvedCommit).not.toBe(second.resolvedCommit);
  });

});
