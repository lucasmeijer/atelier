import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { JsonObject } from "@atelier/core";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { setWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { addProject, getGitIdentity, isGitProjectInit, listProjectEnvironmentVariables, listProjects, projectWorkspaceInit, revealProjectSecrets, type WorkspaceDeleteBlockedDetails } from "@atelier/projects";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type ProvisionWorkspace = Parameters<typeof createWebApp>[0]["provisionWorkspace"];
type ProvisionWorkspaceOptions = Parameters<ProvisionWorkspace>[1];

const openApiDocumentSchema = Type.Object({ paths: Type.Object({}) });
const workspaceCreatedResponseSchema = Type.Object({
  workspace: Type.Object({
    id: Type.String(),
    url: Type.String(),
    phase: Type.Literal("starting"),
  }),
});
const workspaceStatusResponseSchema = Type.Object({
  workspace: Type.Object({
    title: Type.String(),
    phase: Type.String(),
  }),
});
const projectSummarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
});
const projectResponseSchema = Type.Object({ project: projectSummarySchema });
const projectListResponseSchema = Type.Object({ projects: Type.Array(projectSummarySchema) });
const publicProjectProperties = {
  id: Type.String(),
  name: Type.String(),
  gitUrl: Type.String(),
  branch: Type.Union([Type.String(), Type.Null()]),
  sessionShareKey: Type.String(),
};
const environmentVariableSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  value: Type.String(),
});
const environmentVariableResponseSchema = Type.Object({ environmentVariable: environmentVariableSchema });
const deletedProjectEnvironmentVariableResponseSchema = Type.Object({
  deleted: Type.Literal(true),
  environmentVariable: environmentVariableSchema,
}, { additionalProperties: false });
const projectSecretSummarySchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  envName: Type.String(),
  hostPattern: Type.String(),
  placeholder: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
}, { additionalProperties: false });
const projectSecretResponseSchema = Type.Object({ secret: projectSecretSummarySchema }, { additionalProperties: false });
const deletedProjectSecretResponseSchema = Type.Object({
  deleted: Type.Literal(true),
  secret: projectSecretSummarySchema,
}, { additionalProperties: false });
const projectDetailResponseSchema = Type.Object({
  project: Type.Object({
    ...publicProjectProperties,
    environment: Type.Array(environmentVariableSchema),
    secrets: Type.Array(projectSecretSummarySchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const projectDeletionBlockedResponseSchema = Type.Object({
  deleted: Type.Literal(false),
  blocked: Type.Literal(true),
  references: Type.Array(Type.Object({
    workspaceId: Type.String(),
    title: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
const projectDeletionSuccessResponseSchema = Type.Object({
  deleted: Type.Literal(true),
  blocked: Type.Literal(false),
  project: Type.Object(publicProjectProperties, { additionalProperties: false }),
}, { additionalProperties: false });

interface TestAppOptions {
  provision?: (id: string, options?: ProvisionWorkspaceOptions) => Promise<void>;
  inspect?: (id: string) => Promise<WorkspaceDeleteBlockedDetails>;
  destroy?: (id: string) => Promise<void>;
  persistParked?: (id: string, parked: boolean) => Promise<void>;
  devReload?: boolean;
}

function createTestApp(options: TestAppOptions = {}) {
  const registry = createWorkspaceRegistry({
    activityStore: { load: async () => ({}), save: async () => {} },
  });
  const broadcasts: string[] = [];
  const app = createWebApp({
    registry,
    cable: { broadcast: (_identifier, html) => broadcasts.push(html) },
    devReload: options.devReload,
    provisionWorkspace: options.provision ?? (async () => {}),
    provisioningHooks: [],
    inspectDeleteSafety: options.inspect ?? (async (id) => ({ workspaceId: id, issues: [] })),
    destroyWorkspace: options.destroy ?? (async () => {}),
    persistWorkspaceParked: options.persistParked ?? (async () => {}),
    logError: () => {},
  });
  return { app, registry, broadcasts };
}

function post(path: string): Request {
  return new Request(`http://test.local${path}`, { method: "POST", headers: { accept: "text/vnd.turbo-stream.html" } });
}

function postForm(path: string, body: URLSearchParams): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "text/vnd.turbo-stream.html", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function postJson(path: string, body: JsonObject): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withTempDataDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousDataDir = process.env.ATELIER_DATA_DIR;
  const previousGitHubToken = process.env.GH_TOKEN;
  const dataDir = await mkdtemp(join(tmpdir(), "atelier-web-test-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  delete process.env.GH_TOKEN;
  try {
    return await fn();
  } finally {
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await rm(dataDir, { recursive: true, force: true });
  }
}

const blockedDetails = (id: string): WorkspaceDeleteBlockedDetails => ({
  workspaceId: id,
  issues: [{ repo: "demo", uncommittedPaths: ["a.txt"], outgoingCommits: [{ hash: "abc123", subject: "wip" }] }],
});

describe("web app contracts", () => {
  test("HEAD / and /up match their GET status without a body", async () => {
    const { app } = createTestApp();
    const home = await app.fetch(new Request("http://test.local/", { method: "HEAD" }));
    const up = await app.fetch(new Request("http://test.local/up", { method: "HEAD" }));

    expect(home.status).toBe(200);
    expect(await home.text()).toBe("");
    expect(up.status).toBe(200);
    expect(await up.text()).toBe("");
  });

  test("GET /projects/github-search renders GitHub repository options for non-url queries", async () => {
    await withTempDataDir(async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/search/repositories");
        expect(url.searchParams.get("q")).toBe("atelier in:name,description is:public");
        expect(url.searchParams.get("sort")).toBe("stars");
        expect(url.searchParams.get("order")).toBe("desc");
        return Response.json({
          items: [{
            full_name: "org/atelier",
            description: "server-rendered agents",
            private: false,
            clone_url: "https://github.com/org/atelier.git",
            html_url: "https://github.com/org/atelier",
            default_branch: "main",
          }],
        });
      }, originalFetch);
      try {
        const { app } = createTestApp();
        const response = await app.fetch(new Request("http://test.local/projects/github-search?q=atelier"));
        const body = await response.text();

        expect(response.headers.get("content-type")).toContain("text/html");
        expect(body).toContain("org/atelier");
        expect(body).toContain("data-git-url=\"https://github.com/org/atelier.git\"");
        expect(body).not.toContain("public");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("GET /projects/github-search prioritizes private repositories when GitHub is connected", async () => {
    await withTempDataDir(async () => {
      setWorkspaceGitHubToken("github-token");
      const queries: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        queries.push(url.searchParams.get("q") ?? "");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-token");
        return Response.json({
          items: url.searchParams.get("q")?.includes("is:private")
            ? [{ full_name: "me/private-atelier", description: "mine", private: true, clone_url: "https://github.com/me/private-atelier.git", html_url: "https://github.com/me/private-atelier", default_branch: "main" }]
            : [{ full_name: "public/atelier", description: "public", private: false, clone_url: "https://github.com/public/atelier.git", html_url: "https://github.com/public/atelier", default_branch: "main" }],
        });
      }, originalFetch);
      try {
        const { app } = createTestApp();
        const response = await app.fetch(new Request("http://test.local/projects/github-search?q=atelier"));
        const body = await response.text();

        expect(queries.toSorted()).toEqual(["atelier in:name,description is:private", "atelier in:name,description is:public"]);
        expect(body.indexOf("me/private-atelier")).toBeLessThan(body.indexOf("public/atelier"));
        expect(body).toContain("🔒");
        expect(body).toContain("Private repository");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("GET /projects/github-search skips URL-like project specs", async () => {
    await withTempDataDir(async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async () => {
        throw new Error("unexpected fetch");
      }, originalFetch);
      try {
        const { app } = createTestApp();
        const response = await app.fetch(new Request("http://test.local/projects/github-search?q=https%3A%2F%2Fgithub.com%2Forg%2Frepo.git"));
        expect(await response.text()).toBe("");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("POST /workspaces responds with streams and Location before provisioning finishes", async () => {
    const provision = deferred();
    const { app, registry, broadcasts } = createTestApp({ provision: () => provision.promise });
    await registry.seed([]);
    broadcasts.length = 0;

    const response = await app.fetch(post("/workspaces"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    const location = response.headers.get("location") ?? "";
    const id = location.match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";
    expect(id).not.toBe("");
    expect(registry.get(id)?.phase).toBe("starting");

    const body = await response.text();
    expect(body).toContain('target="workspaces_table_rows"');
    expect(body).toContain(`data-workspace-id="${id}"`);
    expect(body).toContain('data-phase="starting"');

    // The broadcast prepends a starting row for everyone (via the rows container).
    const listBroadcast = broadcasts.find((html) => html.includes('target="workspaces_table_rows"'));
    expect(listBroadcast).toBeDefined();
    expect(listBroadcast).toContain('data-phase="starting"');
    // Must be "update" (innerHTML), not "replace": replace would destroy the
    // rows container and break every subsequent list broadcast.
    expect(listBroadcast).toContain('<turbo-stream action="update" target="workspaces_table_rows">');

    broadcasts.length = 0;
    provision.resolve();
    await Bun.sleep(20);
    expect(registry.get(id)?.phase).toBe("ready");
    expect(broadcasts.some((html) => html.includes(`target="workspace_row_${id}"`) && html.includes('data-phase="ready"'))).toBe(true);
  });

  test("failed provisioning marks the workspace failed", async () => {
    const { app, registry } = createTestApp({ provision: async () => { throw new Error("docker exploded"); } });
    await registry.seed([]);

    const response = await app.fetch(post("/workspaces"));
    const id = (response.headers.get("location") ?? "").match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";
    await Bun.sleep(20);

    expect(registry.get(id)?.phase).toBe("failed");
    expect(registry.get(id)?.error).toContain("docker exploded");
  });

  test("failed workspaces can be deleted", async () => {
    const destroyed: string[] = [];
    const inspected: string[] = [];
    const { app, registry, broadcasts } = createTestApp({
      inspect: async (id) => { inspected.push(id); return blockedDetails(id); },
      destroy: async (id) => { destroyed.push(id); },
    });
    await registry.seed([]);
    registry.add("abc", "A");
    registry.setPhase("abc", "failed", "docker exploded");

    const html = await (await app.fetch(new Request("http://test.local/"))).text();
    expect(html).toContain('action="/workspaces/abc/delete" data-action="click->workspace-list#deleteClicked submit->workspace-list#deleteStarted"');
    expect(html).toContain('aria-label="Delete workspace"');

    broadcasts.length = 0;
    const response = await app.fetch(post("/workspaces/abc/delete"));

    expect(response.status).toBe(200);
    await Bun.sleep(20);
    expect(inspected).toEqual([]);
    expect(destroyed).toEqual(["abc"]);
    expect(registry.get("abc")).toBeUndefined();
    expect(broadcasts.some((item) => item.includes('<turbo-stream action="remove" target="workspace_row_abc">'))).toBe(true);
  });

  test("POST /workspaces negotiates asynchronous JSON creation and GET reports readiness", async () => {
    const provision = deferred();
    const seen: Array<{ id: string; options: unknown }> = [];
    const { app, registry } = createTestApp({ provision: (id, options) => { seen.push({ id, options }); return provision.promise; } });
    await registry.seed([]);

    const response = await app.fetch(postJson("/workspaces", { title: "Evaluation" }));
    const body = Value.Parse(workspaceCreatedResponseSchema, await response.json());
    const status = await app.fetch(new Request(`http://test.local/workspaces/${body.workspace.id}`, { headers: { accept: "application/json" } }));
    const statusBody = Value.Parse(workspaceStatusResponseSchema, await status.json());

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("location")).toBe(body.workspace.url);
    expect(body.workspace.phase).toBe("starting");
    expect(statusBody.workspace).toMatchObject({ title: "Evaluation", phase: "starting" });
    expect(registry.get(body.workspace.id)?.init).toBeUndefined();
    expect(seen[0]?.id).toBe(body.workspace.id);

    provision.resolve();
  });

  test("POST /workspaces JSON creates a project workspace with agent context", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git#main")).project;
      const seen: Array<{ id: string; options: ProvisionWorkspaceOptions }> = [];
      const { app, registry } = createTestApp({ provision: async (id, options) => { seen.push({ id, options }); } });
      await registry.seed([]);

      const response = await app.fetch(postJson("/workspaces", {
        source: { type: "project", project: "sample-project" },
        agent: { initialPrompt: "Add tests", model: "openai::gpt", thinkingLevel: "medium" },
      }));
      const body = Value.Parse(workspaceCreatedResponseSchema, await response.json());
      const entry = registry.get(body.workspace.id)!;

      expect(response.status).toBe(202);
      expect(isGitProjectInit(entry.init)).toBe(true);
      expect(isGitProjectInit(entry.init) && entry.init.projectId).toBe(project.id);
      expect(isGitProjectInit(entry.init) && entry.init.name).toBe("sample-project");
      expect(isGitProjectInit(entry.init) && entry.init.gitUrl).toBe("https://github.com/org/sample-project.git");
      expect(isGitProjectInit(entry.init) && entry.init.branch).toBe("main");
      expect(seen[0]?.options?.context).toEqual({ agent: { initialPrompt: "Add tests", model: "openai::gpt", thinkingLevel: "medium", attachmentDraft: "" } });
    });
  });

  test("project configuration routes negotiate complete JSON CRUD without exposing secret values", async () => {
    await withTempDataDir(async () => {
      const { app, registry } = createTestApp();
      await registry.seed([]);
      const specification = "https://github.com/org/json-project.git#main";

      const createdResponse = await app.fetch(postJson("/projects", { gitUrl: specification }));
      const created = Value.Parse(projectResponseSchema, await createdResponse.json());
      const repeatedResponse = await app.fetch(postJson("/projects", { gitUrl: specification }));
      const repeated = Value.Parse(projectResponseSchema, await repeatedResponse.json());
      expect(createdResponse.status).toBe(200);
      expect(repeatedResponse.status).toBe(200);
      expect(repeated.project.id).toBe(created.project.id);

      const listedResponse = await app.fetch(new Request("http://test.local/projects", { headers: { accept: "application/json" } }));
      const listed = Value.Parse(projectListResponseSchema, await listedResponse.json());
      expect(listed.projects.map((project) => project.id)).toEqual([created.project.id]);

      const updatedResponse = await app.fetch(postJson(`/projects/${created.project.id}`, { name: "JSON Project", gitUrl: specification }));
      const updated = Value.Parse(projectResponseSchema, await updatedResponse.json());
      expect(updated.project.name).toBe("JSON Project");

      const environmentCreatedResponse = await app.fetch(postJson(`/projects/${created.project.id}/environment`, { name: "EMPTY_OK", value: "" }));
      const environmentCreated = Value.Parse(environmentVariableResponseSchema, await environmentCreatedResponse.json());
      expect(environmentCreated.environmentVariable.value).toBe("");
      const environmentUpdatedResponse = await app.fetch(postJson(`/projects/${created.project.id}/environment/${environmentCreated.environmentVariable.id}`, { name: "API_URL", value: "https://api.example" }));
      const environmentUpdated = Value.Parse(environmentVariableResponseSchema, await environmentUpdatedResponse.json());
      expect(environmentUpdated.environmentVariable).toMatchObject({ name: "API_URL", value: "https://api.example" });

      const sensitive = "sensitive-value-never-return";
      const secretResponse = await app.fetch(postJson(`/projects/${created.project.id}/secrets`, {
        envName: "POETRY_API_KEY", hostPattern: "api.poetry.example", placeholder: "", secretValue: sensitive,
      }));
      const secretText = await secretResponse.text();
      const secretCreated = Value.Parse(projectSecretResponseSchema, JSON.parse(secretText));
      expect(secretText).not.toContain(sensitive);
      expect(secretCreated.secret).not.toHaveProperty("secretValue");

      const secretUpdateResponse = await app.fetch(postJson(`/projects/${created.project.id}/secrets/${secretCreated.secret.id}`, {
        envName: "POETRY_API_KEY", hostPattern: "packages.example", placeholder: "token",
      }));
      const secretUpdateText = await secretUpdateResponse.text();
      expect(secretUpdateText).not.toContain(sensitive);
      expect((await revealProjectSecrets(created.project.id))[0]?.secretValue).toBe(sensitive);

      const detailResponse = await app.fetch(new Request(`http://test.local/projects/${created.project.id}`, { headers: { accept: "application/json" } }));
      const detailText = await detailResponse.text();
      const detail = Value.Parse(projectDetailResponseSchema, JSON.parse(detailText));
      expect(detail.project.environment).toHaveLength(1);
      expect(detail.project.secrets).toHaveLength(1);
      expect(detailText).not.toContain(sensitive);
      expect(detailText).not.toContain("encryptedSecret");

      const deletedSecretResponse = await app.fetch(postJson(`/projects/${created.project.id}/secrets/${secretCreated.secret.id}/delete`, {}));
      const deletedSecret = Value.Parse(deletedProjectSecretResponseSchema, await deletedSecretResponse.json());
      const deletedEnvironmentResponse = await app.fetch(postJson(`/projects/${created.project.id}/environment/${environmentCreated.environmentVariable.id}/delete`, {}));
      const deletedEnvironment = Value.Parse(deletedProjectEnvironmentVariableResponseSchema, await deletedEnvironmentResponse.json());
      expect(deletedSecret.deleted).toBe(true);
      expect(deletedEnvironment.deleted).toBe(true);
    });
  });

  test("project JSON routes use the structured error envelope for malformed and invalid bodies", async () => {
    await withTempDataDir(async () => {
      const { app, registry } = createTestApp();
      await registry.seed([]);
      const malformed = await app.fetch(new Request("http://test.local/projects", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{",
      }));
      const missing = await app.fetch(postJson("/projects", {}));

      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: { code: "invalid_arguments" } });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: { code: "invalid_arguments", message: "gitUrl is required" } });
    });
  });

  test("project deletion JSON reports success and non-sensitive workspace blockers", async () => {
    await withTempDataDir(async () => {
      const first = (await addProject("https://github.com/org/first.git")).project;
      const second = (await addProject("https://github.com/org/second.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([{ id: "1585eff7", title: "poetry-slideshow", init: projectWorkspaceInit(first) }]);

      const blockedResponse = await app.fetch(postJson(`/projects/${first.id}/delete`, {}));
      const blocked = Value.Parse(projectDeletionBlockedResponseSchema, await blockedResponse.json());
      const deletedResponse = await app.fetch(postJson(`/projects/${second.id}/delete`, {}));
      const deleted = Value.Parse(projectDeletionSuccessResponseSchema, await deletedResponse.json());

      expect(blocked).toEqual({ deleted: false, blocked: true, references: [{ workspaceId: "1585eff7", title: "poetry-slideshow" }] });
      expect(deleted).toEqual({ deleted: true, blocked: false, project: second });
      expect((await listProjects()).projects).toEqual([first]);
    });
  });

  test("GET /workspaces lists JSON summaries while ordinary browsers still redirect", async () => {
    const { app, registry } = createTestApp();
    const project = projectWorkspaceInit({ id: "project-1", name: "demo", gitUrl: "https://example.test/demo.git", branch: null, sessionShareKey: "demo" });
    await registry.seed([{ id: "abc12345", title: "Automation target", parked: true, init: project }]);

    const json = await app.fetch(new Request("http://test.local/workspaces", { headers: { accept: "application/json" } }));
    const browser = await app.fetch(new Request("http://test.local/workspaces"));

    expect(await json.json()).toEqual({ workspaces: [{ id: "abc12345", title: "Automation target", phase: "ready", parked: true, projectId: "project-1" }] });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("http://test.local/");
  });

  test("the role-fixed shell removes the legacy global sidebar", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);

    const home = await (await app.fetch(new Request("http://test.local/"))).text();

    expect(home).toContain('class="app fixed-shell-app"');
    expect(home).toContain("Create or select a workspace");
    expect(home).not.toContain("workspace-shell-sidebar");
    expect(home).not.toContain("workspace-shell#toggle");
  });

  test("the removed REST workspace endpoint is not found and OpenAPI advertises UI JSON operations", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);

    const removed = await app.fetch(postJson("/api/workspaces", {}));
    const openapi = await app.fetch(new Request("http://test.local/openapi.json"));
    const specification = Value.Parse(openApiDocumentSchema, await openapi.json());
    const pathNames = Object.keys(specification.paths);

    expect(removed.status).toBe(404);
    expect(openapi.headers.get("content-type")).toContain("application/json");
    expect(pathNames).toContain("/workspaces");
    expect(pathNames).toContain("/workspaces/{id}/commands/{commandId}");
    expect(pathNames).toContain("/projects");
    expect(pathNames).toContain("/projects/{projectId}");
    expect(pathNames).toContain("/projects/{projectId}/environment/{variableId}/delete");
    expect(pathNames).toContain("/projects/{projectId}/secrets/{secretId}/delete");
    expect(pathNames).toContain("/projects/{projectId}/delete");
    expect(pathNames).not.toContain("/projects/picker");
    expect(pathNames).not.toContain("/api/workspaces");
  });

  test("the project picker launches workspaces and links to project settings", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const home = await (await app.fetch(new Request("http://test.local/"))).text();
      const editor = await (await app.fetch(new Request(`http://test.local/projects/${project.id}/picker`))).text();
      const newProject = await (await app.fetch(new Request("http://test.local/projects/new/picker"))).text();

      expect(home).toContain('id="project-picker-modal"');
      expect(home).toContain(`href="/projects/${project.id}/picker"`);
      expect(home).toContain(`href="/projects/${project.id}/agent-launch" data-turbo-frame="agent_launch_modal"`);
      expect(home).toContain('<turbo-frame id="agent_launch_modal"></turbo-frame>');
      expect(home).not.toContain("Describe what you want the agent to do");
      expect(home).not.toContain('class="sidebar-host-repos"');
      expect(home).toContain('data-modal-opener-target-id-value="project-picker-modal"');
      expect(newProject).toContain('aria-label="Add project"');
      expect(editor).toContain('aria-label="Repository"');
      expect(editor).toContain("project-environment");
      expect(editor).toContain(`action="/projects/${project.id}/environment"`);
      expect(editor).toContain("project-secrets");
      expect(editor).toContain("GH_TOKEN");
      expect(editor).toContain("api.github.com");
      expect(editor).toContain("Injected automatically");
      expect(editor).toContain("Optional token-like value");
      expect(editor).toContain('name="placeholder"');
      expect(editor).toContain('name="secretValue"');
      expect(editor).toContain(`aria-label="Add secret" method="post" action="/projects/${project.id}/secrets"`);
      expect(editor).toContain("The private key stays on the Atelier host");
      expect(editor).toContain(`action="/projects/${project.id}/ssh-key"`);
      expect(editor).toContain('name="privateKey"');
      expect(editor).toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(editor).toContain("ssh-keygen -t ed25519");
      expect(editor).toContain("authorized_keys");
      expect(home).toContain(`id="delete_project_modal_${project.id}"`);
      expect(home).toContain(`action="/projects/${project.id}/delete"`);
    });
  });

  test("agent launch dialogs are loaded fresh into one Turbo Frame", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const first = await (await app.fetch(new Request(`http://test.local/projects/${project.id}/agent-launch`))).text();
      const second = await (await app.fetch(new Request(`http://test.local/projects/${project.id}/agent-launch`))).text();
      const firstDraft = first.match(/name="attachmentDraft" value="([^"]+)"/)?.[1];
      const secondDraft = second.match(/name="attachmentDraft" value="([^"]+)"/)?.[1];

      expect(first).toContain('<turbo-frame id="agent_launch_modal">');
      expect(first).toContain('data-controller="agent-launch-dialog"');
      expect(first).toContain('data-controller="submit-shortcut"');
      expect(first).toContain('<turbo-frame id="agent_launch_settings">');
      expect(first).toContain(`action="/project-agent-workspaces/${project.id}"`);
      expect(first).toContain('aria-label="Describe what you want the agent to do… (optional)"');
      expect(firstDraft).toBeTruthy();
      expect(secondDraft).toBeTruthy();
      expect(firstDraft).not.toBe(secondDraft);
    });
  });

  test("project environment variables can be added from the project editor", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const response = await app.fetch(postForm(`/projects/${project.id}/environment`, new URLSearchParams({ name: "API_URL", value: "https://api.example.com" })));

      expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
      expect(await listProjectEnvironmentVariables(project.id)).toMatchObject([{ name: "API_URL", value: "https://api.example.com" }]);
      expect(await response.text()).toContain(`target="project_environment_${project.id}"`);
    });
  });

  test("adding a project responds with streams and treats repeated submits as success", async () => {
    await withTempDataDir(async () => {
      const { app, registry } = createTestApp();
      await registry.seed([]);
      const form = new URLSearchParams({ gitUrl: "https://github.com/org/sample-project.git" });

      const response = await app.fetch(postForm("/projects", form));
      const repeated = await app.fetch(postForm("/projects", form));
      const body = await response.text();
      const repeatedBody = await repeated.text();

      expect(response.status).toBe(200);
      expect(repeated.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
      expect((await listProjects()).projects).toHaveLength(1);
      expect(body).toContain('target="project_picker_frame"');
      expect(body).toContain('target="project_modals"');
      expect(body).toContain("sample-project");
      expect(repeatedBody).toContain('target="project_picker_frame"');
      expect(repeatedBody).not.toContain("project already exists");
    });
  });

  test("deleting an unreferenced project removes it from the project picker", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const response = await app.fetch(post(`/projects/${encodeURIComponent(project.id)}/delete`));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect((await listProjects()).projects).toEqual([]);
      expect(body).toContain('target="project_picker_frame"');
      expect(body).toContain('target="project_modals"');
      expect(body).not.toContain("sample-project");
    });
  });

  test("deleting a referenced project is blocked", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([{ id: "abc", title: "A", init: projectWorkspaceInit(project) }]);

      const response = await app.fetch(post(`/projects/${encodeURIComponent(project.id)}/delete`));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("Project is in use");
      expect(body).toContain("A");
      expect(body).toContain('target="project_modals"');
      expect(body).toContain(`id="delete_project_modal_${project.id}"`);
      expect(body).not.toContain(`action="remove" target="delete_project_modal_${project.id}"`);
      expect((await listProjects()).projects).toEqual([project]);
    });
  });

  test("forkCurrentWorkspaceFromAgent creates a fork source with required title and agent options", async () => {
    let captured: { id: string; options?: ProvisionWorkspaceOptions } | undefined;
    const { app, registry } = createTestApp({ provision: async (id, options) => { captured = { id, options }; } });
    const init = projectWorkspaceInit({ id: "project-1", name: "demo", gitUrl: "https://example.test/demo.git", branch: "main", sessionShareKey: "share-1" });
    registry.add("source", "Source", init);
    registry.setPhase("source", "ready");

    const result = await app.forkCurrentWorkspaceFromAgent("source", { title: "Forked", initialPrompt: "continue", model: "provider/model", thinkingLevel: "high", attachmentDraft: "draft-1" });

    expect(result.url).toBe(`/workspaces/${result.id}`);
    expect(registry.get(result.id)?.title).toBe("Forked");
    expect(captured?.id).toBe(result.id);
    expect(captured?.options?.init).toEqual(init);
    expect(captured?.options?.fork).toEqual({ sourceWorkspaceId: "source" });
    expect(captured?.options?.context).toEqual({ fork: { sourceWorkspaceId: "source" }, agent: { initialPrompt: "continue", model: "provider/model", thinkingLevel: "high", attachmentDraft: "draft-1" } });
  });

  test("project-created workspaces use the project name as their temporary title", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const response = await app.fetch(postForm(`/project-agent-workspaces/${encodeURIComponent(project.id)}`, new URLSearchParams({ text: "do it" })));
      const body = await response.text();
      const entry = registry.list()[0]!;

      expect(response.status).toBe(200);
      expect(entry.title).toBeNull();
      expect(isGitProjectInit(entry.init)).toBe(true);
      expect(isGitProjectInit(entry.init) && entry.init.projectId).toBe(project.id);
      expect(isGitProjectInit(entry.init) && entry.init.name).toBe("sample-project");
      expect(body).toContain("sample-project");
      expect(body).toContain('action="update" target="agent_launch_modal"');
      expect(body).not.toContain("do it");
      expect(body).not.toContain("sample-project.git");
      expect(body).not.toContain(`Workspace ${entry.id}`);
    });
  });

  test("workspace creation keeps selected agent settings without an initial prompt", async () => {
    await withTempDataDir(async () => {
      let captured: ProvisionWorkspaceOptions | undefined;
      const { app, registry } = createTestApp({ provision: async (_id, options) => { captured = options; } });
      await registry.seed([]);

      const response = await app.fetch(postForm("/agent-workspaces", new URLSearchParams({
        text: "",
        model: "openai-codex::gpt-5.6-sol",
        level: "medium",
        attachmentDraft: "",
      })));

      expect(response.status).toBe(200);
      expect(captured?.context).toEqual({ agent: { initialPrompt: "", model: "openai-codex::gpt-5.6-sol", thinkingLevel: "medium", serviceTier: "default", attachmentDraft: "" } });
      expect(await response.text()).toContain('action="update" target="agent_launch_modal"');
    });
  });

  test("blocked delete returns the confirmation modal to the requester and restores the row", async () => {
    const { app, registry, broadcasts } = createTestApp({ inspect: async (id) => blockedDetails(id) });
    await registry.seed([{ id: "abc", title: "A" }]);
    broadcasts.length = 0;

    const response = await app.fetch(post("/workspaces/abc/delete"));
    const body = await response.text();

    expect(body).toContain('id="delete-workspace-modal"');
    expect(body).toContain('action="append" target="body"');
    expect(body).toContain("/workspaces/abc/delete?force=1");
    expect(registry.get("abc")?.phase).toBe("ready");

    // Other clients saw the pending state come and go via row broadcasts.
    expect(broadcasts.some((html) => html.includes('data-phase="checking_delete"'))).toBe(true);
    expect(broadcasts.some((html) => html.includes('data-phase="ready"'))).toBe(true);
  });

  test("allowed delete walks checking_delete -> deleting -> row removal", async () => {
    const destroy = deferred();
    const { app, registry, broadcasts } = createTestApp({ destroy: () => destroy.promise });
    await registry.seed([{ id: "abc", title: "A" }]);
    broadcasts.length = 0;

    const response = await app.fetch(post("/workspaces/abc/delete"));
    expect(response.status).toBe(200);
    expect(registry.get("abc")?.phase).toBe("deleting");
    expect(broadcasts.some((html) => html.includes('data-phase="deleting"'))).toBe(true);

    destroy.resolve();
    await Bun.sleep(20);
    expect(registry.get("abc")).toBeUndefined();
    expect(broadcasts.some((html) => html.includes('<turbo-stream action="remove" target="workspace_row_abc">'))).toBe(true);
  });

  test("park and unpark toggle workspace rows with zzz icon before the delete button", async () => {
    const parked: Array<{ id: string; parked: boolean }> = [];
    const { app, registry } = createTestApp({ persistParked: async (id, value) => { parked.push({ id, parked: value }); } });
    await registry.seed([{ id: "a", title: "A", parked: false }, { id: "b", title: "B", parked: true }]);

    expect(registry.list().map((entry) => entry.id)).toEqual(["a", "b"]);

    const parkedPage = await app.fetch(new Request("http://test.local/workspaces/b"));
    expect(parkedPage.status).toBe(302);
    expect(parkedPage.headers.get("location")).toBe("http://test.local/");
    const parkedJson = await (await app.fetch(new Request("http://test.local/workspaces/b", { headers: { accept: "application/json" } }))).json();
    expect(parkedJson.workspace).not.toHaveProperty("tabs");

    const parkResponse = await app.fetch(post("/workspaces/a/park"));
    const parkBody = await parkResponse.text();
    expect(registry.get("a")?.parked).toBe(true);
    expect(parked.at(-1)).toEqual({ id: "a", parked: true });
    expect(parkBody).toContain("parked");
    expect(parkBody).toContain('aria-label="Unpark workspace"');
    expect(parkBody).toContain("💤");
    expect(parkBody).toContain('data-turbo="true" data-action="turbo:submit-end->workspace-list#parkToggled"');
    expect(parkBody).not.toContain('class="workspace-row-delete"');
    expect(parkBody).not.toContain('class="workspace-row-edit"');

    const unparkBody = await (await app.fetch(post("/workspaces/a/unpark"))).text();
    expect(registry.get("a")?.parked).toBe(false);
    expect(unparkBody.indexOf('class="workspace-row-park"')).toBeLessThan(unparkBody.indexOf('class="workspace-row-delete"'));
    expect(parked.at(-1)).toEqual({ id: "a", parked: false });

    const fallback = await app.fetch(new Request("http://test.local/workspaces/a/park", { method: "POST", headers: { referer: "http://test.local/" } }));
    expect(fallback.status).toBe(303);
    expect(fallback.headers.get("location")).toBe("http://test.local/");
    expect(registry.get("a")?.parked).toBe(true);

    const home = await app.fetch(new Request("http://test.local/"));
    expect(home.status).toBe(200);
    const homeBody = await home.text();
    expect(homeBody).toContain("Create or select a workspace");
    expect(homeBody).not.toContain('href="/workspaces/a"');
    expect(homeBody).not.toContain('href="/workspaces/b"');
  });

  test("workspace rows warn when the workspace image is outdated", async () => {
    const { registry, broadcasts } = createTestApp();

    await registry.seed([{ id: "abc", title: "A", imageOutdated: true }]);

    const row = broadcasts.find((item) => item.includes('id="workspace_row_abc"')) ?? "";
    expect(row).toContain("has-version-warning");
    expect(row).toContain("workspace-version-warning");
  });

  test("ready workspace rows include status and unread preload metadata", async () => {
    const { app, registry, broadcasts } = createTestApp();
    const html = await (await app.fetch(new Request("http://test.local/"))).text();
    expect(html).toContain('data-workspace-residency-max-resident-value="5"');

    await registry.seed([{ id: "abc", title: "A" }]);
    const readyBroadcast = broadcasts.find((item) => item.includes('id="workspace_status_abc"')) ?? "";
    expect(readyBroadcast.indexOf('id="workspace_status_abc"')).toBeLessThan(readyBroadcast.indexOf('class="workspace-row-delete"'));

    broadcasts.length = 0;
    registry.setTabBusy("abc", "agent:Agent 1", true);
    const busyBroadcast = broadcasts.find((item) => item.includes('target="workspace_status_abc"')) ?? "";
    expect(busyBroadcast).toContain('class="status-spinner sm"');
    expect(busyBroadcast).toContain('Workspace busy');

    broadcasts.length = 0;
    registry.setTabBusy("abc", "agent:Agent 1", false);
    registry.setTabUnread("abc", "agent:Agent 1", true);
    const unreadBroadcast = broadcasts.findLast((item) => item.includes('target="workspace_status_abc"')) ?? "";
    expect(unreadBroadcast).toContain('data-workspace-state="unread"');
    expect(unreadBroadcast).toMatch(/data-workspace-unread-at="\d+"/);
  });

  test("broadcast HTML never contains per-client state (visible rows, selection inputs)", async () => {
    const provision = deferred();
    const destroy = deferred();
    const { app, registry, broadcasts } = createTestApp({ provision: () => provision.promise, destroy: () => destroy.promise });
    await registry.seed([{ id: "abc", title: "A" }]);

    await app.fetch(post("/workspaces"));
    provision.resolve();
    await Bun.sleep(20);
    await app.fetch(post("/workspaces/abc/delete"));
    destroy.resolve();
    await Bun.sleep(20);
    registry.setTabBusy("abc", "agent:1", true);
    registry.setTitle("abc", "Renamed");

    expect(broadcasts.length).toBeGreaterThan(0);
    for (const html of broadcasts) {
      expect(html).not.toMatch(/class="[^"]*workspace-row[^"]*\bvisible\b/);
      expect(html).not.toMatch(/class="[^"]*workspace-detail-resident[^"]*\bvisible\b/);
      expect(html).not.toContain('name="selected"');
    }
  });

  test("reordering broadcasts keep working after earlier list broadcasts (touch moves a row up)", async () => {
    let clock = 1000;
    const registry = createWorkspaceRegistry({
      activityStore: { load: async () => ({ a: 500, b: 400 }), save: async () => {} },
      now: () => ++clock,
    });
    const broadcasts: string[] = [];
    createWebApp({
      registry,
      cable: { broadcast: (_identifier, html) => broadcasts.push(html) },
      provisionWorkspace: async () => {},
      provisioningHooks: [],
      inspectDeleteSafety: async (id) => ({ workspaceId: id, issues: [] }),
      destroyWorkspace: async () => {},
    });
    await registry.seed([
      { id: "a", title: null },
      { id: "b", title: null },
    ]);
    broadcasts.length = 0;

    registry.touch("b");

    const reorder = broadcasts.find((html) => html.includes('target="workspaces_table_rows"'));
    expect(reorder).toBeDefined();
    expect(reorder).toContain('action="update"');
    // "b" now renders before "a".
    expect(reorder!.indexOf('id="workspace_row_b"')).toBeLessThan(reorder!.indexOf('id="workspace_row_a"'));
  });

  test("GitHub connect flow asks for GitHub CLI token output", async () => {
    const { app } = createTestApp();

    const response = await app.fetch(post("/settings/github/flow"));
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(body).toContain("GitHub CLI token");
    expect(body).toContain("gh auth login");
    expect(body).toContain("gh auth token");
    expect(body).toContain("Paste output from gh auth token");
    expect(body).not.toContain("personal-access-tokens");
  });

  test("GitHub connect validates and stores pasted GitHub CLI token", async () => {
    await withTempDataDir(async () => {
      const originalFetch = globalThis.fetch;
      try {
        const fetchMock = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url === "https://api.github.com/user") return Response.json({ id: 583231, login: "octocat", name: "Mona Lisa", email: "octocat@github.com" });
          if (url === "https://api.github.com/user/emails") return Response.json([]);
          throw new Error(`unexpected fetch ${url}`);
        }, { preconnect: originalFetch.preconnect }) satisfies typeof fetch;
        globalThis.fetch = fetchMock;
        const { app } = createTestApp();

        const response = await app.fetch(postForm("/settings/github/connect", new URLSearchParams({ token: "cli-token" })));
        const body = await response.text();

        expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
        expect(body).toContain('target="settings_dialog"');
        expect(body).toContain("Connected");
        expect(body).toContain('target="settings_flow_dialog"');
        expect(await getGitIdentity()).toEqual({ name: "Mona Lisa", email: "octocat@github.com" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("page shell serves client dependencies locally and uses cable instead of a workspace EventSource", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([{ id: "abc", title: "A" }]);

    const page = await app.fetch(new Request("http://test.local/"));
    const html = await page.text();
    expect(html).toContain('data-controller="cable-shell"');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
    expect(html).toMatch(/<script type="module" src="\/(?:assets\/)?workspace-[^"]+\.js"><\/script>|<script type="module" src="\/workspace\.js"><\/script>/);
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("turbo-stream-source");
    expect(html).not.toContain("/workspace-events/stream");

    const legacy = await app.fetch(new Request("http://test.local/workspace-events/stream"));
    expect(legacy.status).toBe(404);
  });

  test("development page shell enables the reload controller only in dev mode", async () => {
    const productionHtml = await (await createTestApp().app.fetch(new Request("http://test.local/"))).text();
    const developmentHtml = await (await createTestApp({ devReload: true }).app.fetch(new Request("http://test.local/"))).text();

    expect(productionHtml).not.toContain("dev-reload");
    expect(developmentHtml).toContain('data-controller="cable-shell dev-reload"');
    expect(developmentHtml).toContain('data-dev-reload-url-value="/__atelier_dev_reload"');
  });
});
