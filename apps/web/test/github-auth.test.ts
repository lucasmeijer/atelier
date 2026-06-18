import { afterEach, describe, expect, test } from "bun:test";
import { validateGitHubToken } from "../src/server/github-auth.ts";

const originalFetch = globalThis.fetch;

describe("GitHub auth", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects blank tokens without calling GitHub", async () => {
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;

    expect(await validateGitHubToken("  ")).toEqual({ ok: false, message: "Enter a GitHub token." });
    expect(called).toBe(false);
  });

  test("validates tokens against the GitHub user API", async () => {
    let auth = "";
    globalThis.fetch = ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(url).toBe("https://api.github.com/user");
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(Response.json({ login: "octocat" }));
    }) as unknown as typeof fetch;

    expect(await validateGitHubToken(" gh_cli_token_test ")).toEqual({ ok: true, login: "octocat" });
    expect(auth).toBe("Bearer gh_cli_token_test");
  });

  test("reports rejected tokens", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("bad", { status: 401 }))) as unknown as typeof fetch;

    expect(await validateGitHubToken("bad-token")).toEqual({ ok: false, message: "GitHub rejected that token. Check that it is active and has repository read access." });
  });
});
