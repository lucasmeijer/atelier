import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, createProjectSecret } from "@atelier/projects";
import { createWorkspaceSecretContext, clearWorkspaceGitHubToken, forgetWorkspaceSecretContext, getWorkspaceSecretContext, setWorkspaceGitHubToken } from "../../src/secrets/workspace-secrets.ts";

describe("workspace secrets", () => {
  let previousDataDir: string | undefined;
  let previousGitHubToken: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    dataDir = await mkdtemp(join(tmpdir(), "atelier-workspace-secrets-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    clearWorkspaceGitHubToken();
    forgetWorkspaceSecretContext("test-workspace");
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses deterministic placeholders for workspace env secrets", async () => {
    setWorkspaceGitHubToken("real-secret");
    const context = await createWorkspaceSecretContext("test-workspace");

    expect(context.env.GH_TOKEN).toBe("ATELIER_INJECT_GH_TOKEN");
    expect(context.secrets).toContainEqual({
      name: "GH_TOKEN",
      placeholder: "ATELIER_INJECT_GH_TOKEN",
      hosts: ["github.com", "api.github.com"],
    });
  });

  test("includes encrypted project secrets for project workspaces", async () => {
    const project = (await addProject("https://github.com/org/repo.git")).project;
    await createProjectSecret(project.id, { envName: "API_TOKEN", hostPattern: "api.example.com, *.example.org", secretValue: "real-secret" });

    const context = await createWorkspaceSecretContext("test-workspace", { type: "project.git", projectId: project.id, name: "Project", gitUrl: "https://github.com/org/repo.git", branch: null, sessionShareKey: "Project" });
    const result = await context.hooks.onRequest!(new Request("https://api.example.com/v1", { headers: { authorization: "Bearer ATELIER_INJECT_API_TOKEN" } }));

    expect(context.env.API_TOKEN).toBe("ATELIER_INJECT_API_TOKEN");
    expect(context.secrets).toContainEqual({ name: "API_TOKEN", placeholder: "ATELIER_INJECT_API_TOKEN", hosts: ["api.example.com", "*.example.org"] });
    expect((result as Request).headers.get("authorization")).toBe("Bearer real-secret");
  });

  test("rebuilds context on demand after in-memory state is forgotten", async () => {
    setWorkspaceGitHubToken("real-secret");
    forgetWorkspaceSecretContext("test-workspace");

    const context = await getWorkspaceSecretContext("test-workspace");

    expect(context?.env.GH_TOKEN).toBe("ATELIER_INJECT_GH_TOKEN");
  });

  test("passes an inherited placeholder onward for nested Atelier", async () => {
    process.env.GH_TOKEN = "ATELIER_INJECT_GH_TOKEN";

    const context = await createWorkspaceSecretContext("test-workspace");
    const basic = Buffer.from("x-access-token:ATELIER_INJECT_GH_TOKEN").toString("base64");
    const result = await context.hooks.onRequest!(new Request("https://github.com/repo.git", { headers: { authorization: `Basic ${basic}` } }));

    expect((result as Request).headers.get("authorization")).toBe(`Basic ${basic}`);
  });
});
