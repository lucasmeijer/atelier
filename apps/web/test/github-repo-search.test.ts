import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubRepositorySearchRateLimitError, searchGitHubRepositories, shouldSearchGitHubRepositories } from "../src/server/github-repo-search.ts";

const originalFetch = globalThis.fetch;
let previousDataDir: string | undefined;
let previousToken: string | undefined;
let dataDir: string;
let queries: string[];

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  previousToken = process.env.GH_TOKEN;
  dataDir = await mkdtemp(join(tmpdir(), "atelier-repo-search-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  process.env.GH_TOKEN = crypto.randomUUID();
  queries = [];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  if (previousToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = previousToken;
  await rm(dataDir, { recursive: true, force: true });
});

function repository(fullName: string, privateRepo = false) {
  return { full_name: fullName, description: null, private: privateRepo, clone_url: `https://github.com/${fullName}.git`, html_url: `https://github.com/${fullName}`, default_branch: "main" };
}

function stubSearch(search: (query: string) => ReturnType<typeof repository>[]) {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get("Authorization")).toBe(process.env.GH_TOKEN ? `Bearer ${process.env.GH_TOKEN}` : null);
    expect(url.searchParams.get("per_page")).toBe("25");
    expect(url.pathname).toBe("/search/repositories");
    const query = url.searchParams.get("q")!;
    queries.push(query);
    return Response.json({ items: search(query) });
  }, { preconnect: originalFetch.preconnect });
}

test("explicit GitHub URLs bypass search while repository names remain searchable", () => {
  expect(shouldSearchGitHubRepositories("github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchGitHubRepositories(" GitHub.com/octocat/Hello-World.git#main ")).toBe(false);
  expect(shouldSearchGitHubRepositories("https://github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchGitHubRepositories("Hello-World")).toBe(true);
});

test("one search prioritizes private repositories among 25 matches and displays at most 12", async () => {
  stubSearch(() => [
    ...Array.from({ length: 11 }, (_, index) => repository(`public/widget-${index}`)),
    repository("private/widget", true),
    ...Array.from({ length: 13 }, (_, index) => repository(`public/other-${index}`)),
  ]);
  const results = await searchGitHubRepositories("widget");
  expect(results).toHaveLength(12);
  expect(results[0]!.fullName).toBe("private/widget");
  expect(results.slice(1).map((repo) => repo.fullName)).toEqual(Array.from({ length: 11 }, (_, index) => `public/widget-${index}`));
  expect(queries).toEqual(["widget in:name,description"]);
  await searchGitHubRepositories(" WIDGET ");
  expect(queries).toHaveLength(1);
});

test("anonymous searches use one request", async () => {
  delete process.env.GH_TOKEN;
  stubSearch(() => [repository("public/anonymous-widget")]);
  expect(await searchGitHubRepositories("anonymous-widget")).toHaveLength(1);
  expect(queries).toEqual(["anonymous-widget in:name,description"]);
});

test("rate limits remain explicit and preserve the retry delay", async () => {
  globalThis.fetch = Object.assign(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }), { preconnect: originalFetch.preconnect });
  try {
    await searchGitHubRepositories("limited");
    throw new Error("Expected rate limit");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubRepositorySearchRateLimitError);
    if (!(error instanceof GitHubRepositorySearchRateLimitError)) throw error;
    expect(error.retryAfterSeconds).toBe(30);
  }
});
