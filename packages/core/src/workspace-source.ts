import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { defaultDataDir } from "./data-dir.ts";
import type { CommandResult } from "./docker.ts";
import { AtelierCoreError, invalidArguments } from "./errors.ts";

export interface PreparedWorkspaceSource {
  workspaceId: string;
  worktreePath: string;
  cleanupPath: string;
  gitUrl: string;
  branch: string | null;
  resolvedCommit: string;
  templateKey: string;
}

const templateLocks = new Map<string, Promise<void>>();

function sourceRoot(): string {
  return defaultDataDir();
}

function templateKey(gitUrl: string, branch: string | null): string {
  return createHash("sha256").update(`${gitUrl.trim()}\0${branch?.trim() ?? ""}`).digest("hex").slice(0, 16);
}

function templateDir(key: string): string {
  return join(sourceRoot(), "git-templates", key);
}

function templateRepoPath(key: string): string {
  return join(templateDir(key), "repo");
}

function workspaceSourceDir(workspaceId: string): string {
  return join(sourceRoot(), "workspaces", workspaceId);
}

async function withTemplateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // This is intentionally process-local. If Atelier is ever run as multiple
  // server processes against the same ATELIER_DATA_DIR, replace this with a
  // file lock around the same critical section.
  const previous = templateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const tail = previous.then(() => current, () => current);
  templateLocks.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (templateLocks.get(key) === tail) templateLocks.delete(key);
  }
}

async function command(name: string, args: string[], options: { env?: Record<string, string | undefined> } = {}): Promise<CommandResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([name, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(options.env ?? {}),
      },
    });
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function requireCommand(name: string, args: string[], options: { env?: Record<string, string | undefined>; errorCode?: string } = {}): Promise<CommandResult> {
  const result = await command(name, args, options);
  if (result.exitCode !== 0) {
    throw new AtelierCoreError(options.errorCode ?? "workspace_source_failed", (result.stderr || result.stdout).trim() || `${name} ${args.join(" ")} failed`);
  }
  return result;
}

async function git(args: string[], options: { errorCode?: string } = {}): Promise<CommandResult> {
  const token = await githubTokenAsync();
  const credentialHelper = `!f() { test "$1" = get || exit 0; token="\${GH_TOKEN:-}"; [ -n "$token" ] || exit 0; echo username=x-access-token; echo password="$token"; }; f`;
  return await requireCommand("git", ["-c", `credential.helper=${credentialHelper}`, ...args], {
    env: token ? { GH_TOKEN: token } : undefined,
    errorCode: options.errorCode ?? "git_error",
  });
}

async function githubTokenAsync(): Promise<string | undefined> {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const tokenPath = join(homedir(), "GH_TOKEN");
  if (!existsSync(tokenPath)) return undefined;
  const text = await readFile(tokenPath, "utf8").catch(() => "");
  return text.trim() || undefined;
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

async function ensureLfs(repoPath: string, branch: string | null): Promise<void> {
  await requireCommand("git", ["lfs", "version"], { errorCode: "git_lfs_unavailable" });
  await git(["-C", repoPath, "lfs", "install", "--local"], { errorCode: "git_lfs_error" });
  const args = branch ? ["-C", repoPath, "lfs", "pull", "origin", branch] : ["-C", repoPath, "lfs", "pull"];
  await git(args, { errorCode: "git_lfs_error" });
}

async function ensureTemplate(gitUrl: string, branch: string | null, key: string): Promise<{ repoPath: string; resolvedCommit: string; effectiveBranch: string | null }> {
  const dir = templateDir(key);
  const repoPath = templateRepoPath(key);
  await mkdir(dir, { recursive: true });

  if (!await pathExists(repoPath)) {
    const tmpPath = join(dir, `repo.tmp-${process.pid}-${Date.now()}`);
    await rm(tmpPath, { recursive: true, force: true });
    try {
      await git(["clone", gitUrl, tmpPath], { errorCode: "git_clone_failed" });
      await rename(tmpPath, repoPath);
    } catch (error) {
      await rm(tmpPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  await git(["-C", repoPath, "remote", "set-url", "origin", gitUrl]);
  await git(["-C", repoPath, "fetch", "--prune", "--tags", "origin"]);

  let effectiveBranch = branch;
  let resetRef: string;
  if (branch) {
    resetRef = `origin/${branch}`;
    await git(["-C", repoPath, "rev-parse", "--verify", resetRef]);
    await git(["-C", repoPath, "checkout", "-B", branch, resetRef]);
  } else {
    await git(["-C", repoPath, "remote", "set-head", "origin", "-a"]);
    const head = await git(["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const remoteHead = head.stdout.trim();
    if (!remoteHead.startsWith("origin/")) throw new AtelierCoreError("git_error", `could not resolve origin default branch for ${gitUrl}`);
    effectiveBranch = remoteHead.slice("origin/".length);
    resetRef = remoteHead;
    await git(["-C", repoPath, "checkout", "-B", effectiveBranch, resetRef]);
  }

  await git(["-C", repoPath, "reset", "--hard", resetRef]);
  await git(["-C", repoPath, "clean", "-ffdx"]);
  await ensureLfs(repoPath, effectiveBranch);

  const status = await git(["-C", repoPath, "status", "--porcelain=v1"]);
  if (status.stdout.trim()) throw new AtelierCoreError("git_dirty_template", `template checkout is dirty after reset: ${status.stdout.trim()}`);

  const head = await git(["-C", repoPath, "rev-parse", "HEAD"]);
  const metadata = {
    gitUrl,
    branch,
    effectiveBranch,
    templateKey: key,
    resolvedCommit: head.stdout.trim(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  return { repoPath, resolvedCommit: head.stdout.trim(), effectiveBranch };
}

async function cowCopy(src: string, dest: string): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    await requireCommand("cp", ["-cR", src, dest], { errorCode: "cow_unavailable" });
    return;
  }
  if (os === "linux") {
    await requireCommand("cp", ["--reflink=always", "-a", src, dest], { errorCode: "cow_unavailable" });
    return;
  }
  throw new AtelierCoreError("cow_unavailable", `copy-on-write workspace copies are not supported on ${os}`);
}

async function verifyStandaloneWorktree(worktreePath: string): Promise<void> {
  await git(["-C", worktreePath, "rev-parse", "--is-inside-work-tree"]);
  const common = await git(["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = await realpath(resolve(common.stdout.trim()));
  const expected = await realpath(resolve(join(worktreePath, ".git")));
  if (commonDir !== expected) {
    throw new AtelierCoreError("workspace_source_invalid", `workspace git common dir is ${commonDir}, expected ${expected}`);
  }
  if (await pathExists(join(worktreePath, ".git", "objects", "info", "alternates"))) {
    throw new AtelierCoreError("workspace_source_invalid", "workspace git checkout unexpectedly uses alternates");
  }
}

export async function prepareWorkspaceSource(options: { workspaceId: string; gitUrl: string; branch: string | null }): Promise<PreparedWorkspaceSource> {
  const gitUrl = options.gitUrl.trim();
  if (!gitUrl) throw invalidArguments("missing git URL");
  const branch = options.branch?.trim() || null;
  const key = templateKey(gitUrl, branch);
  const cleanupPath = workspaceSourceDir(options.workspaceId);
  const worktreePath = join(cleanupPath, "work");

  return await withTemplateLock(key, async () => {
    if (await pathExists(worktreePath)) throw new AtelierCoreError("workspace_source_exists", `workspace source already exists: ${worktreePath}`);
    await mkdir(cleanupPath, { recursive: true });
    const tmpWorkPath = join(cleanupPath, `work.tmp-${process.pid}-${Date.now()}`);
    await rm(tmpWorkPath, { recursive: true, force: true });

    try {
      const template = await ensureTemplate(gitUrl, branch, key);
      await cowCopy(template.repoPath, tmpWorkPath);
      await verifyStandaloneWorktree(tmpWorkPath);
      await rename(tmpWorkPath, worktreePath);

      const metadata = {
        workspaceId: options.workspaceId,
        gitUrl,
        branch,
        effectiveBranch: template.effectiveBranch,
        templateKey: key,
        resolvedCommit: template.resolvedCommit,
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(cleanupPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

      return {
        workspaceId: options.workspaceId,
        worktreePath,
        cleanupPath,
        gitUrl,
        branch,
        resolvedCommit: template.resolvedCommit,
        templateKey: key,
      };
    } catch (error) {
      await rm(tmpWorkPath, { recursive: true, force: true }).catch(() => undefined);
      await rm(cleanupPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function deleteWorkspaceSource(workspaceId: string): Promise<void> {
  await rm(workspaceSourceDir(workspaceId), { recursive: true, force: true });
}
