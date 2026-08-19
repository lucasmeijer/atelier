import { afterEach, describe, expect, test } from "bun:test";
import { validateGitHubToken } from "../src/server/github-auth.ts";

const originalFetch = globalThis.fetch;

function fetchStub(
  implementation: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: originalFetch.preconnect });
}

describe("GitHub auth", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects blank tokens without calling GitHub", async () => {
    let called = false;
    globalThis.fetch = fetchStub(() => {
      called = true;
      throw new Error("unexpected fetch");
    });

    expect(await validateGitHubToken("  ")).toEqual({ ok: false, message: "Enter a GitHub token." });
    expect(called).toBe(false);
  });

  test("validates tokens against the GitHub user API", async () => {
    let auth = "";
    globalThis.fetch = fetchStub((url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url === "https://api.github.com/user") return Promise.resolve(Response.json({ id: 583231, login: "octocat", name: "Mona Lisa", email: null }));
      if (url === "https://api.github.com/user/emails") return Promise.resolve(Response.json([{ email: "octocat@github.com", primary: true, verified: true }]));
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    expect(await validateGitHubToken(" gh_cli_token_test ")).toEqual({ ok: true, name: "Mona Lisa", email: "octocat@github.com" });
    expect(auth).toBe("Bearer gh_cli_token_test");
  });

  test("falls back to the GitHub noreply email when private emails are unavailable", async () => {
    globalThis.fetch = fetchStub((url) => {
      if (url === "https://api.github.com/user") return Promise.resolve(Response.json({ id: 583231, login: "octocat", name: "" }));
      if (url === "https://api.github.com/user/emails") return Promise.resolve(new Response("forbidden", { status: 403 }));
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    expect(await validateGitHubToken("token")).toEqual({ ok: true, name: "octocat", email: "583231+octocat@users.noreply.github.com" });
  });

  test("reports rejected tokens", async () => {
    globalThis.fetch = fetchStub(() => Promise.resolve(new Response("bad", { status: 401 })));

    expect(await validateGitHubToken("bad-token")).toEqual({ ok: false, message: "GitHub rejected that token. Check that it is active and has repository read access." });
  });

  test("rejects malformed GitHub user responses", async () => {
    globalThis.fetch = fetchStub(() => Promise.resolve(Response.json({ id: "583231", login: "octocat" })));

    expect(await validateGitHubToken("token")).toEqual({ ok: false, message: "GitHub returned an invalid user response. Try again." });
  });
});
