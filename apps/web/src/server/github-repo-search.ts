import { createHash } from "node:crypto";
import { discoverHostGitHubToken } from "@atelier/proxy-egress";
import { escapeHtml, looksLikeProjectSpec } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

const githubRepositorySearchResponseSchema = Type.Object({
  items: Type.Array(Type.Object({
    full_name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    private: Type.Boolean(),
    clone_url: Type.String(),
    html_url: Type.String(),
    default_branch: Type.String(),
  })),
});

const searchCache = new Map<string, { expiresAt: number; results: GitHubRepositorySearchResult[] }>();
const searchCacheMs = 60_000;

export class GitHubRepositorySearchRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "GitHubRepositorySearchRateLimitError";
  }
}

export interface GitHubRepositorySearchResult {
  fullName: string;
  description: string | null;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
}

export function shouldSearchGitHubRepositories(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length >= 2 && !looksLikeProjectSpec(trimmed);
}

async function searchGitHubRepositoryPage(query: string, visibility: "public" | "private", token: string | undefined, perPage: number): Promise<GitHubRepositorySearchResult[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", `${query.trim()} in:name,description is:${visibility}`);
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(perPage));

  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 403 || response.status === 429) throw new GitHubRepositorySearchRateLimitError(`GitHub repository search failed: ${response.status} ${message}`, Number(response.headers.get("retry-after") ?? undefined) || undefined);
    throw new Error(`GitHub repository search failed: ${response.status} ${message}`);
  }

  const body = Value.Parse(githubRepositorySearchResponseSchema, await response.json());
  return body.items.map((repo) => ({
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    cloneUrl: repo.clone_url,
    htmlUrl: repo.html_url,
    defaultBranch: repo.default_branch,
  }));
}

export async function searchGitHubRepositories(query: string): Promise<GitHubRepositorySearchResult[]> {
  const now = Date.now();
  for (const [key, entry] of searchCache) {
    if (entry.expiresAt <= now) searchCache.delete(key);
  }

  const token = discoverHostGitHubToken();
  const normalized = query.trim().toLowerCase();
  const credentialKey = token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "public";
  const cacheKey = `${credentialKey}:${normalized}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached.results;

  let results: GitHubRepositorySearchResult[];
  if (token) {
    const privateResults = await searchGitHubRepositoryPage(query, "private", token, 12);
    results = privateResults.length >= 12
      ? privateResults
      : [...privateResults, ...await searchGitHubRepositoryPage(query, "public", token, 12 - privateResults.length)];
  } else {
    results = await searchGitHubRepositoryPage(query, "public", token, 12);
  }
  searchCache.set(cacheKey, { expiresAt: Date.now() + searchCacheMs, results });
  return results;
}

export function renderGitHubRepositorySearchRateLimitMenu(error: GitHubRepositorySearchRateLimitError): string {
  const wait = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} seconds.` : " Try again in a few minutes.";
  return `<div class="agent-completion-menu empty">GitHub search is rate limited.${escapeHtml(wait)}</div>`;
}

export function renderGitHubRepositorySearchMenu(repositories: readonly GitHubRepositorySearchResult[], query: string): string {
  if (!shouldSearchGitHubRepositories(query)) return "";
  if (repositories.length === 0) return `<div class="agent-completion-menu empty">No GitHub repositories</div>`;
  return `<div class="agent-completion-menu action-list" role="listbox" aria-label="GitHub repositories">${repositories.map((repo, index) => {
    const visibility = repo.private ? `<span class="agent-template-args" title="Private repository" aria-label="Private repository">🔒</span>` : "";
    const description = repo.description || repo.htmlUrl;
    return `<button type="button" class="agent-completion-option action-item action-item__primary agent-template-option${index === 0 ? " active" : ""}" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-git-url="${escapeHtml(repo.cloneUrl)}" title="${escapeHtml(repo.htmlUrl)}">
      <span class="agent-template-name">${escapeHtml(repo.fullName)}</span>${visibility}<span class="agent-template-desc">${escapeHtml(description)}</span>
    </button>`;
  }).join("")}</div>`;
}
