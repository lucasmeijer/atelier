import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAtelierRuntimeContextForTests } from "@atelier/core";
import { authenticateProxyRequest, ensureWorkspaceProxyAuthToken, forgetWorkspaceProxyAuthToken } from "../src/egress/auth-store.ts";

let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "atelier-proxy-egress-test-data-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  resetAtelierRuntimeContextForTests();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  resetAtelierRuntimeContextForTests();
  await rm(dataDir, { recursive: true, force: true });
});

describe("workspace egress proxy internals", () => {
  test("persists and forgets proxy auth tokens", async () => {
    const token = await ensureWorkspaceProxyAuthToken("ws1");
    expect(token).toHaveLength(64);
    expect(await ensureWorkspaceProxyAuthToken("ws1")).toBe(token);

    const req = { headers: { "proxy-authorization": `Basic ${Buffer.from(`ws1:${token}`).toString("base64")}` } };
    expect(await authenticateProxyRequest(req)).toBe("ws1");

    await forgetWorkspaceProxyAuthToken("ws1");
    await expect(authenticateProxyRequest(req)).rejects.toThrow("invalid proxy authentication");
  });

  test("rejects malformed persisted proxy credentials", async () => {
    const proxyDir = join(dataDir, "proxy");
    await mkdir(proxyDir, { recursive: true });
    await writeFile(join(proxyDir, "workspace-auth.json"), JSON.stringify({ version: 1, workspaces: { ws1: { token: 42 } } }));

    await expect(ensureWorkspaceProxyAuthToken("ws1")).rejects.toThrow();
  });
});
