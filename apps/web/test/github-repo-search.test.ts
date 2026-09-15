import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubRepositorySearchRateLimitError, searchGitHubRepositories } from "../src/server/github-repo-search.ts";

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
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([{ login: "my-org" }]);
    expect(url.pathname).toBe("/search/repositories");
    const query = url.searchParams.get("q")!;
    queries.push(query);
    return Response.json({ items: search(query) });
  }, { preconnect: originalFetch.preconnect });
}

test("account and organization repositories precede unrelated private and popular public repositories, without duplicates", async () => {
  stubSearch((query) => {
    if (query.includes("user:me user:my-org")) return [repository("me/widget"), repository("my-org/widget", true)];
    if (query.includes("is:private")) return [repository("my-org/widget", true), repository("collaborator/widget", true)];
    return [repository("popular/widget"), repository("me/widget")];
  });
  expect((await searchGitHubRepositories("widget")).map((repo) => repo.fullName)).toEqual([
    "me/widget", "my-org/widget", "collaborator/widget", "popular/widget",
  ]);
  expect(queries).toHaveLength(3);
  await searchGitHubRepositories(" WIDGET ");
  expect(queries).toHaveLength(3);
});

test("stops before global search when affiliated repositories fill the result limit", async () => {
  stubSearch(() => Array.from({ length: 12 }, (_, index) => repository(`me/widget-${index}`)));
  expect(await searchGitHubRepositories("widget")).toHaveLength(12);
  expect(queries).toEqual(["widget in:name,description user:me user:my-org"]);
});

test("anonymous searches only request public repositories", async () => {
  delete process.env.GH_TOKEN;
  stubSearch(() => [repository("public/anonymous-widget")]);
  expect(await searchGitHubRepositories("anonymous-widget")).toHaveLength(1);
  expect(queries).toEqual(["anonymous-widget in:name,description is:public"]);
});

test("owner discovery is cached per credential, not shared across accounts", async () => {
  let users = 0;
  stubSearch(() => []);
  const searchFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/user") users += 1;
    return searchFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  await searchGitHubRepositories("one");
  await searchGitHubRepositories("two");
  expect(users).toBe(1);
  process.env.GH_TOKEN = crypto.randomUUID();
  await searchGitHubRepositories("one");
  expect(users).toBe(2);
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

test("includes organizations beyond the first page", async () => {
  stubSearch(() => []);
  const searchFetch = globalThis.fetch;
  const pages: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/orgs") {
      const page = url.searchParams.get("page")!;
      pages.push(page);
      return Response.json(page === "1"
        ? Array.from({ length: 100 }, (_, index) => ({ login: `org-${index}` }))
        : [{ login: "last-org" }]);
    }
    return searchFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  await searchGitHubRepositories("paginated");
  expect(pages).toEqual(["1", "2"]);
  expect(queries[0]).toContain("user:last-org");
});

test("fills remaining slots with unique results and caps the merged list at twelve", async () => {
  stubSearch((query) => {
    if (query.includes("user:me")) return [repository("me/widget")];
    if (query.includes("is:private")) return [];
    return [repository("me/widget"), ...Array.from({ length: 11 }, (_, index) => repository(`public/widget-${index}`))];
  });
  const results = await searchGitHubRepositories("widget");
  expect(results).toHaveLength(12);
  expect(new Set(results.map((repo) => repo.fullName)).size).toBe(12);
  expect(results[0]!.fullName).toBe("me/widget");
});
