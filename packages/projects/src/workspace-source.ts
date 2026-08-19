import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import {
  atelierDataPath,
  AtelierCoreError,
  discoverHostGitHubToken,
  dockerHostAtelierDataPath,
  getAtelierRuntimeContext,
  gitHubCredentialHelperCommand,
  invalidArguments,
  shellQuote,
  type AtelierEventBus,
  type CommandResult,
} from "@atelier/core";
import { runHostObservableCommand, tailTerminalText } from "@atelier/observable-terminal/server";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { projectEnvironment } from "./environment.ts";
import { isGitProjectInit } from "./project.ts";

export interface PreparedWorkspaceSource {
  workspaceId: string;
  worktreePath: string;
  cleanupPath: string;
  gitUrl: string;
  branch: string | null;
  resolvedCommit: string;
  templateKey: string;
}

export interface GitWorkspaceSourceRequest {
  gitUrl: string;
  branch: string | null;
}

const workspaceSourceMetadataSchema = Type.Object({
  workspaceId: Type.String(),
  gitUrl: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  effectiveBranch: Type.Union([Type.String(), Type.Null()]),
  templateKey: Type.String(),
  resolvedCommit: Type.String(),
  createdAt: Type.String(),
});
type WorkspaceSourceMetadata = Static<typeof workspaceSourceMetadataSchema>;

const templateLocks = new Map<string, Promise<void>>();
const reflinkSupportByDir = new Map<string, Promise<boolean>>();
const regularCopyWarnings = new Set<string>();
const provisionLog = new AsyncLocalStorage<string>();

function sourceRoot(): string {
  return getAtelierRuntimeContext().atelierDataDir;
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

export function projectDataDirKey(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex").slice(0, 16);
}

export async function projectPersistentMount(projectId: string): Promise<{ source: string; target: "/persistent" }> {
  const runtime = getAtelierRuntimeContext();
  const key = projectDataDirKey(projectId);
  await mkdir(atelierDataPath(runtime, "projects", key, "persistent"), { recursive: true });
  return { source: dockerHostAtelierDataPath(runtime, "projects", key, "persistent"), target: "/persistent" };
}

function workspaceWorktreePath(workspaceId: string): string {
  return join(workspaceSourceDir(workspaceId), "work");
}

async function withTemplateLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // This is intentionally process-local. If Atelier is ever run as multiple
  // server processes against the same Atelier data dir, replace this with a
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
  const logPath = provisionLog.getStore();
  if (logPath) await appendFile(logPath, `\n$ ${[name, ...args].map(shellQuote).join(" ")}\n`).catch(() => undefined);
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
  if (logPath) await appendFile(logPath, `${stdout}${stderr}`).catch(() => undefined);
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
  const token = discoverHostGitHubToken();
  return await requireCommand("git", ["-c", `credential.helper=${gitHubCredentialHelperCommand}`, ...args], {
    env: token ? { GH_TOKEN: token } : undefined,
    errorCode: options.errorCode ?? "git_error",
  });
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

async function ensureTemplate(gitUrl: string, branch: string | null, key: string, options: { workspaceId: string; events?: AtelierEventBus; logPath: string }): Promise<{ repoPath: string; resolvedCommit: string; effectiveBranch: string | null }> {
  const dir = templateDir(key);
  const repoPath = templateRepoPath(key);
  const tmpPath = join(dir, `repo.tmp-${process.pid}-${Date.now()}`);
  const effectiveBranchPath = join(dir, `effective-branch-${process.pid}-${Date.now()}.txt`);
  const resolvedCommitPath = join(dir, `resolved-commit-${process.pid}-${Date.now()}.txt`);
  await mkdir(dir, { recursive: true });
  await rm(tmpPath, { recursive: true, force: true });
  await rm(effectiveBranchPath, { force: true });
  await rm(resolvedCommitPath, { force: true });

  const token = discoverHostGitHubToken();
  const script = `
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
repo_path=${shellQuote(repoPath)}
tmp_path=${shellQuote(tmpPath)}
git_url=${shellQuote(gitUrl)}
branch=${shellQuote(branch ?? "")}
credential_helper=${shellQuote(gitHubCredentialHelperCommand)}
effective_branch_file=${shellQuote(effectiveBranchPath)}
resolved_commit_file=${shellQuote(resolvedCommitPath)}

git_cmd() { git -c credential.helper="$credential_helper" "$@"; }
trap 'rm -rf "$tmp_path"' EXIT

if [ ! -d "$repo_path/.git" ]; then
  rm -rf "$tmp_path"
  git_cmd clone "$git_url" "$tmp_path"
  rm -rf "$repo_path"
  mv "$tmp_path" "$repo_path"
fi

git_cmd -C "$repo_path" remote set-url origin "$git_url"
git_cmd -C "$repo_path" fetch --prune --force --tags origin

if [ -n "$branch" ]; then
  effective_branch="$branch"
  reset_ref="origin/$branch"
  git_cmd -C "$repo_path" rev-parse --verify "$reset_ref"
  git_cmd -C "$repo_path" checkout -B "$effective_branch" "$reset_ref"
else
  git_cmd -C "$repo_path" remote set-head origin -a
  remote_head="$(git_cmd -C "$repo_path" symbolic-ref --short refs/remotes/origin/HEAD)"
  case "$remote_head" in origin/*) ;; *) echo "could not resolve origin default branch for $git_url" >&2; exit 2 ;; esac
  effective_branch="\${remote_head#origin/}"
  reset_ref="$remote_head"
  git_cmd -C "$repo_path" checkout -B "$effective_branch" "$reset_ref"
fi

git_cmd -C "$repo_path" reset --hard "$reset_ref"
git_cmd -C "$repo_path" clean -ffdx
git_cmd lfs version
git_cmd -C "$repo_path" lfs install --local
git_cmd -C "$repo_path" lfs pull origin "$effective_branch"
git_cmd -C "$repo_path" submodule sync --recursive
git_cmd -C "$repo_path" submodule update --init --recursive --checkout --force
git_cmd -C "$repo_path" submodule foreach --quiet --recursive 'git clean -ffdx && git lfs install --local && git lfs pull'

status="$(git_cmd -C "$repo_path" status --porcelain=v1)"
if [ -n "$status" ]; then
  echo "template checkout is dirty after reset:" >&2
  echo "$status" >&2
  exit 3
fi

git_cmd -C "$repo_path" rev-parse HEAD > "$resolved_commit_file"
printf '%s\n' "$effective_branch" > "$effective_branch_file"
`;

  const result = await runHostObservableCommand({
    session: `atelier-provision-git-${crypto.randomUUID().slice(0, 8)}`,
    cwd: dir,
    command: script,
    env: token ? { GH_TOKEN: token } : undefined,
    onSessionStarted: async (session) => {
      await options.events?.emit("workspace_provision_step", { workspaceId: options.workspaceId, id: "project.git", label: "Clone project", parentId: "workspace.init", status: "running", terminal: { kind: "host-tmux", session } });
    },
  });
  await appendFile(options.logPath, result.output).catch(() => undefined);
  if (result.exitCode !== 0) throw new AtelierCoreError("git_error", tailTerminalText(result.output) || `git provisioning failed with exit code ${result.exitCode}`);

  const effectiveBranch = (await readFile(effectiveBranchPath, "utf8")).trim() || null;
  const resolvedCommit = (await readFile(resolvedCommitPath, "utf8")).trim();
  await rm(effectiveBranchPath, { force: true });
  await rm(resolvedCommitPath, { force: true });

  const metadata = {
    gitUrl,
    branch,
    effectiveBranch,
    templateKey: key,
    resolvedCommit,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  return { repoPath, resolvedCommit, effectiveBranch };
}

function reflinkCopyArgs(src: string, dest: string): string[] | null {
  const os = platform();
  if (os === "darwin") return ["-cR", src, dest];
  if (os === "linux") return ["--reflink=always", "-a", src, dest];
  return null;
}

function regularCopyArgs(src: string, dest: string): string[] | null {
  const os = platform();
  if (os === "darwin") return ["-pR", src, dest];
  if (os === "linux") return ["-a", src, dest];
  return null;
}

async function detectReflinkSupport(dir: string): Promise<boolean> {
  const realDir = await realpath(dir).catch(() => resolve(dir));
  const cached = reflinkSupportByDir.get(realDir);
  if (cached) return await cached;

  const probe = (async () => {
    const args = reflinkCopyArgs("", "");
    if (!args) return false;

    const probeDir = join(dir, `.reflink-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const src = join(probeDir, "src");
    const dest = join(probeDir, "dest");
    try {
      await mkdir(probeDir, { recursive: true });
      await writeFile(src, "atelier reflink probe\n");
      const result = await command("cp", reflinkCopyArgs(src, dest)!);
      return result.exitCode === 0;
    } finally {
      await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  reflinkSupportByDir.set(realDir, probe);
  return await probe;
}

function warnRegularCopy(dir: string): void {
  if (regularCopyWarnings.has(dir)) return;
  regularCopyWarnings.add(dir);
  console.warn(`Atelier warning: ${dir} does not appear to support copy-on-write/reflink copies; workspace creation will use regular copies and may be slower than ideal.`);
}

async function copyWorkspaceTemplate(src: string, dest: string, supportProbeDir: string): Promise<void> {
  if (await detectReflinkSupport(supportProbeDir)) {
    const args = reflinkCopyArgs(src, dest);
    if (!args) throw new AtelierCoreError("cow_unavailable", `copy-on-write workspace copies are not supported on ${platform()}`);
    await requireCommand("cp", args, { errorCode: "cow_unavailable" });
    return;
  }

  warnRegularCopy(supportProbeDir);
  const args = regularCopyArgs(src, dest);
  if (!args) throw new AtelierCoreError("copy_unavailable", `workspace template copies are not supported on ${platform()}`);
  await requireCommand("cp", args, { errorCode: "copy_unavailable" });
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

export async function prepareWorkspaceSource(options: { workspaceId: string; gitUrl: string; branch: string | null; worktreePath?: string; events?: AtelierEventBus }): Promise<PreparedWorkspaceSource> {
  const gitUrl = options.gitUrl.trim();
  if (!gitUrl) throw invalidArguments("missing git URL");
  const branch = options.branch?.trim() || null;
  const key = templateKey(gitUrl, branch);
  const cleanupPath = workspaceSourceDir(options.workspaceId);
  const worktreePath = options.worktreePath ?? workspaceWorktreePath(options.workspaceId);

  return await withTemplateLock(key, async () => {
    await mkdir(cleanupPath, { recursive: true });
    if (await pathExists(worktreePath)) {
      const entries = await readdir(worktreePath);
      if (entries.length > 0) throw new AtelierCoreError("workspace_source_exists", `workspace source is not empty: ${worktreePath}`);
    }
    const tmpWorkPath = join(cleanupPath, `work.tmp-${process.pid}-${Date.now()}`);
    await rm(tmpWorkPath, { recursive: true, force: true });
    const logPath = join(cleanupPath, `project-provision-${Date.now()}.log`);

    try {
      await writeFile(logPath, `Preparing project ${gitUrl}${branch ? `#${branch}` : ""}\n`);
      const template = await provisionLog.run(logPath, () => ensureTemplate(gitUrl, branch, key, { workspaceId: options.workspaceId, events: options.events, logPath }));
      await copyWorkspaceTemplate(template.repoPath, tmpWorkPath, sourceRoot());
      await verifyStandaloneWorktree(tmpWorkPath);
      await rm(worktreePath, { recursive: true, force: true });
      await rename(tmpWorkPath, worktreePath);

      const metadata: WorkspaceSourceMetadata = {
        workspaceId: options.workspaceId,
        gitUrl,
        branch,
        effectiveBranch: template.effectiveBranch,
        templateKey: key,
        resolvedCommit: template.resolvedCommit,
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(cleanupPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

      await options.events?.emit("workspace_provision_step", { workspaceId: options.workspaceId, id: "project.git", label: "Clone project", parentId: "workspace.init", status: "done", output: tailTerminalText(await readFile(logPath, "utf8").catch(() => "")) });
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
      await options.events?.emit("workspace_provision_step", { workspaceId: options.workspaceId, id: "project.git", label: "Clone project", parentId: "workspace.init", status: "failed", output: tailTerminalText(await readFile(logPath, "utf8").catch(() => "")), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

export function registerProjectWorkspaceInitEvents(events: AtelierEventBus): void {
  events.on("workspace_source_prepare", async ({ workspaceId, init, workHostPath }) => {
    if (!isGitProjectInit(init)) return;
    await prepareWorkspaceSource({ workspaceId, gitUrl: init.gitUrl, branch: init.branch, worktreePath: workHostPath, events });
  });

  events.on("workspace_plan_prepare", async ({ workspaceId, init, plan }) => {
    if (isGitProjectInit(init)) {
      plan.mounts.push({ type: "bind", ...(await projectPersistentMount(init.projectId)) });
      Object.assign(plan.env, await projectEnvironment(init.projectId));
    }

    const metadataPath = join(workspaceSourceDir(workspaceId), "metadata.json");
    if (!existsSync(metadataPath)) return;
    const metadata = Value.Parse(workspaceSourceMetadataSchema, JSON.parse(await readFile(metadataPath, "utf8")));
    plan.labels["com.atelier.source-commit"] = metadata.resolvedCommit;
    plan.labels["com.atelier.source-template"] = metadata.templateKey;
  });
}
