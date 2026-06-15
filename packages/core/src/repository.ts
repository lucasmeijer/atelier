import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { defaultDataDir } from "./data-dir.ts";
import { AtelierCoreError } from "./errors.ts";

export interface RepositorySummary {
  id: string;
  name: string;
  gitUrl: string;
  branch: string | null;
}

export interface RepositoryListResult {
  repos: RepositorySummary[];
}

export interface AddRepositoryResult {
  repo: RepositorySummary;
}

interface RepositoryStore {
  repositories: RepositorySummary[];
}

export function repositoriesFile(dataDir = defaultDataDir()): string {
  return join(dataDir, "repositories.json");
}

function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/?#]+$/, "");
  const last = basename(trimmed);
  const withoutGit = last.endsWith(".git") ? last.slice(0, -4) : last;
  const safe = withoutGit.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!safe || safe === "." || safe === "..") throw new AtelierCoreError("invalid_git_url", `could not derive repo name from ${url}`);
  return safe;
}

function repoId(gitUrl: string, branch: string | null): string {
  const base = repoNameFromUrl(gitUrl);
  const digest = createHash("sha256").update(`${gitUrl}\0${branch ?? ""}`).digest("hex").slice(0, 8);
  return `${base}-${digest}`;
}

export function formatRepositorySpec(repo: Pick<RepositorySummary, "gitUrl" | "branch">): string {
  return `${repo.gitUrl}${repo.branch ? `#${repo.branch}` : ""}`;
}

export function parseRepositorySpec(spec: string): { gitUrl: string; branch: string | null } {
  const trimmed = spec.trim();
  if (!trimmed) throw new AtelierCoreError("invalid_git_url", "git url is required");

  const [gitUrl, branch] = trimmed.split(/#(.+)/, 2).map((part) => part.trim());
  return gitUrl && branch ? { gitUrl, branch } : { gitUrl: trimmed, branch: null };
}

async function readStore(file: string): Promise<RepositoryStore> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<RepositoryStore>;
    const repositories = Array.isArray(parsed.repositories) ? parsed.repositories : [];
    return {
      repositories: repositories.flatMap((repo) => {
        if (!repo || typeof repo !== "object") return [];
        const candidate = repo as Partial<RepositorySummary>;
        if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.gitUrl !== "string") return [];
        return [{ id: candidate.id, name: candidate.name, gitUrl: candidate.gitUrl, branch: typeof candidate.branch === "string" && candidate.branch.trim() ? candidate.branch : null }];
      }),
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { repositories: [] };
    throw error;
  }
}

async function writeStore(file: string, store: RepositoryStore): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export async function listRepositories(file = repositoriesFile()): Promise<RepositoryListResult> {
  const store = await readStore(file);
  const repos = [...store.repositories].sort((a, b) => a.name.localeCompare(b.name) || (a.branch ?? "").localeCompare(b.branch ?? "") || a.gitUrl.localeCompare(b.gitUrl));
  return { repos };
}

export async function addRepository(spec: string, file = repositoriesFile()): Promise<AddRepositoryResult> {
  const { gitUrl, branch } = parseRepositorySpec(spec);
  const id = repoId(gitUrl, branch);
  const store = await readStore(file);
  if (store.repositories.some((repo) => repo.id === id || (repo.gitUrl === gitUrl && repo.branch === branch))) {
    throw new AtelierCoreError("repository_exists", `repository already exists: ${formatRepositorySpec({ gitUrl, branch })}`);
  }
  const repo = { id, name: repoNameFromUrl(gitUrl), gitUrl, branch };
  store.repositories.push(repo);
  await writeStore(file, store);
  return { repo };
}
