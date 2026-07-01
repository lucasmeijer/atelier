import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearWorkspaceGitHubToken, discoverHostGitHubToken, hasWorkspaceGitHubToken, setWorkspaceGitHubToken } from "../src/github-token.ts";

let previousDataDir: string | undefined;
let previousGitHubToken: string | undefined;
let dataDir: string;

describe("GitHub token discovery", () => {
  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    dataDir = await mkdtemp(join(tmpdir(), "atelier-github-token-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    clearWorkspaceGitHubToken();
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses stored token before environment token", () => {
    process.env.GH_TOKEN = "env-token";
    setWorkspaceGitHubToken("stored-token");

    expect(discoverHostGitHubToken()).toBe("stored-token");
    expect(hasWorkspaceGitHubToken()).toBe(true);
  });

  test("falls back to GH_TOKEN when no token is stored", () => {
    process.env.GH_TOKEN = " env-token ";

    expect(discoverHostGitHubToken()).toBe("env-token");
    expect(hasWorkspaceGitHubToken()).toBe(true);
  });

  test("falls back to GH_TOKEN when stored token file is blank", async () => {
    const tokenPath = join(dataDir, "workspace", "github-token");
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, "\n");
    process.env.GH_TOKEN = "env-token";

    expect(discoverHostGitHubToken()).toBe("env-token");
  });

  test("treats blank GH_TOKEN as missing", () => {
    process.env.GH_TOKEN = "  ";

    expect(discoverHostGitHubToken()).toBeUndefined();
    expect(hasWorkspaceGitHubToken()).toBe(false);
  });
});
