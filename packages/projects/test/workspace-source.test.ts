import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearWorkspaceGitHubToken, createAtelierEventBus, setWorkspaceGitHubToken } from "@atelier/core";
import { prepareWorkspaceSource, registerProjectWorkspaceInitEvents, type GitProjectInitInstruction } from "@atelier/projects";
import type { WorkspaceDockerPlan } from "@atelier/workspace";

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
  let previousGitHubToken: string | undefined;
  const tempRoots: string[] = [];

  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    dataDir = await mkdtemp(join(tmpdir(), "atelier-data-test-"));
    tempRoots.push(dataDir);
    process.env.ATELIER_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    clearWorkspaceGitHubToken();
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
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

  test("applies the stored GitHub token to host-side git commands before container creation", async () => {
    const fixture = await createRemote();
    tempRoots.push(fixture.root);
    const realGit = (await run(["which", "git"])).stdout.trim();
    const fakeBin = await mkdtemp(join(tmpdir(), "atelier-fake-git-"));
    tempRoots.push(fakeBin);
    const tokenLog = join(fakeBin, "tokens.log");
    const fakeGit = join(fakeBin, "git");
    await writeFile(fakeGit, `#!/bin/sh\nprintf '%s\\n' "\${GH_TOKEN-}" >> ${JSON.stringify(tokenLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
    await chmod(fakeGit, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    setWorkspaceGitHubToken("stored-token");
    try {
      await prepareWorkspaceSource({ workspaceId: "ws-token", gitUrl: fixture.remote, branch: "main" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const tokens = (await Bun.file(tokenLog).text()).trim().split("\n");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token === "stored-token")).toBe(true);
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

  test("adds a shared /persistent bind mount for workspaces from the same saved project", async () => {
    const events = createAtelierEventBus();
    registerProjectWorkspaceInitEvents(events);
    const planFor = async (workspaceId: string, projectId: string): Promise<WorkspaceDockerPlan> => {
      const init: GitProjectInitInstruction = { type: "project.git", projectId, name: projectId, gitUrl: `https://example.test/${projectId}.git`, branch: null, sessionShareKey: projectId };
      const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], publishes: [], extraArgs: [], initScripts: [], cleanup: [] };
      await events.emit("workspace_plan_prepare", { workspaceId, init, workHostPath: join(dataDir, "workspaces", workspaceId, "work"), workContainerPath: "/work", plan });
      return plan;
    };

    const first = await planFor("ws1", "project-a");
    const second = await planFor("ws2", "project-a");
    const other = await planFor("ws3", "project-b");
    const projectAKey = createHash("sha256").update("project-a").digest("hex").slice(0, 16);
    const projectAPath = join(dataDir, "projects", projectAKey, "persistent");

    expect(first.mounts).toEqual([{ type: "bind", source: projectAPath, target: "/persistent" }]);
    expect(second.mounts).toEqual(first.mounts);
    expect(other.mounts[0]!.source).not.toBe(projectAPath);
    expect((await stat(projectAPath)).isDirectory()).toBe(true);
    expect(first.initScripts).toEqual([]);
  });

});
