import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, platform } from "node:os";
import { AtelierCoreError } from "./errors.ts";
import { runCommand } from "./process.ts";

export interface ManagedRepoSummary {
  name: string;
  path: string;
  remoteUrl: string | null;
}

export interface ManagedRepoListResult {
  repos: ManagedRepoSummary[];
}

export interface AddManagedRepoResult {
  repo: ManagedRepoSummary;
}

export function defaultDataDir(): string {
  if (process.env.ATELIER_DATA_DIR) return process.env.ATELIER_DATA_DIR;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "atelier");
  return "/var/lib/atelier";
}

export function managedReposDir(dataDir = defaultDataDir()): string {
  return join(dataDir, "repos");
}

function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/?#]+$/, "");
  const last = basename(trimmed);
  const withoutGit = last.endsWith(".git") ? last.slice(0, -4) : last;
  const safe = withoutGit.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe || safe === "." || safe === "..") throw new AtelierCoreError("invalid_git_url", `could not derive repo name from ${url}`);
  return safe;
}

async function isBareGitRepo(path: string): Promise<boolean> {
  const bare = await runCommand(["git", "-C", path, "rev-parse", "--is-bare-repository"]);
  return bare.exitCode === 0 && bare.stdout.trim() === "true";
}

async function remoteUrl(path: string): Promise<string | null> {
  const remote = await runCommand(["git", "-C", path, "remote", "get-url", "origin"]);
  if (remote.exitCode !== 0) return null;
  return remote.stdout.trim() || null;
}

export async function listManagedRepos(dataDir = managedReposDir()): Promise<ManagedRepoListResult> {
  let entries: Array<{ isDirectory(): boolean; name: string }>;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { repos: [] };
    throw error;
  }

  const repos: ManagedRepoSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dataDir, entry.name);
    if (await isBareGitRepo(path)) repos.push({ name: entry.name, path, remoteUrl: await remoteUrl(path) });
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { repos };
}

export async function addManagedRepo(gitUrl: string, dataDir = managedReposDir()): Promise<AddManagedRepoResult> {
  const trimmed = gitUrl.trim();
  if (!trimmed) throw new AtelierCoreError("invalid_git_url", "git url is required");

  await mkdir(dataDir, { recursive: true });
  const name = `${repoNameFromUrl(trimmed)}.git`;
  const path = join(dataDir, name);

  try {
    await stat(path);
    throw new AtelierCoreError("managed_repo_exists", `managed repo already exists: ${name}`);
  } catch (error) {
    if (error instanceof AtelierCoreError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }

  const cloned = await runCommand(["git", "clone", "--bare", trimmed, path]);
  if (cloned.exitCode !== 0) {
    throw new AtelierCoreError("git_clone_failed", (cloned.stderr || cloned.stdout).trim() || `could not clone ${trimmed}`);
  }

  return { repo: { name, path, remoteUrl: trimmed } };
}
