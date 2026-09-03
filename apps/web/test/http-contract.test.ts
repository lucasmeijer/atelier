import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  addProject,
  isGitProjectInit,
  listProjects,
  projectWorkspaceInit,
  revealProjectSecrets,
} from "@atelier/projects";
import {
  createTestApp,
  deferred,
  postJson,
  temporaryAtelierDataDir,
  type ProvisionWorkspaceOptions,
} from "./support/test-web-app.ts";

const workspaceCreatedResponseSchema = Type.Object({
  workspace: Type.Object({ id: Type.String(), url: Type.String(), phase: Type.Literal("starting") }),
});
const workspaceStatusResponseSchema = Type.Object({
  workspace: Type.Object({ title: Type.String(), phase: Type.String() }),
});
const projectSummarySchema = Type.Object({ id: Type.String(), name: Type.String() });
const projectResponseSchema = Type.Object({ project: projectSummarySchema });
const projectListResponseSchema = Type.Object({ projects: Type.Array(projectSummarySchema) });
const environmentVariableSchema = Type.Object({ id: Type.String(), name: Type.String(), value: Type.String() });
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
    id: Type.String(),
    name: Type.String(),
    gitUrl: Type.String(),
    branch: Type.Union([Type.String(), Type.Null()]),
    sessionShareKey: Type.String(),
    environment: Type.Array(environmentVariableSchema),
    secrets: Type.Array(projectSecretSummarySchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const projectDeletionBlockedResponseSchema = Type.Object({
  deleted: Type.Literal(false),
  blocked: Type.Literal(true),
  references: Type.Array(Type.Object({ workspaceId: Type.String(), title: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false });
const dataDir = temporaryAtelierDataDir();
beforeEach(dataDir.setUp);
afterEach(dataDir.tearDown);

describe("HTTP contracts", () => {
  test("HEAD / and /up match their GET status without a body", async () => {
    const { app } = createTestApp();
    const home = await app.fetch(new Request("http://test.local/", { method: "HEAD" }));
    const up = await app.fetch(new Request("http://test.local/up", { method: "HEAD" }));

    expect(home.status).toBe(200);
    expect(await home.text()).toBe("");
    expect(up.status).toBe(200);
    expect(await up.text()).toBe("");
  });

  test("creates a workspace asynchronously and reports readiness through JSON", async () => {
    const provision = deferred();
    const seen: Array<{ id: string; options: unknown }> = [];
    const { app, registry } = createTestApp({
      provision: (id, options) => {
        seen.push({ id, options });
        return provision.promise;
      },
    });
    await registry.seed([]);

    const response = await app.fetch(postJson("/workspaces", { title: "Evaluation" }));
    const body = Value.Parse(workspaceCreatedResponseSchema, await response.json());
    const status = await app.fetch(new Request(`http://test.local/workspaces/${body.workspace.id}`, {
      headers: { accept: "application/json" },
    }));
    const statusBody = Value.Parse(workspaceStatusResponseSchema, await status.json());

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("location")).toBe(body.workspace.url);
    expect(statusBody.workspace).toMatchObject({ title: "Evaluation", phase: "starting" });
    expect(registry.get(body.workspace.id)?.init).toBeUndefined();
    expect(seen[0]?.id).toBe(body.workspace.id);

    provision.resolve();
  });

  test("creates a project workspace with agent context through JSON", async () => {
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
    expect(isGitProjectInit(entry.init) && entry.init).toMatchObject({
      projectId: project.id,
      name: "sample-project",
      gitUrl: "https://github.com/org/sample-project.git",
      branch: "main",
    });
    expect(seen[0]?.options?.context).toEqual({
      agent: { initialPrompt: "Add tests", initialPromptMode: "composer", model: "", thinkingLevel: "", attachmentDraft: "" },
    });
  });

  test("project JSON CRUD never exposes secret values", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);
    const specification = "https://github.com/org/json-project.git#main";

    const createdResponse = await app.fetch(postJson("/projects", { gitUrl: specification }));
    const created = Value.Parse(projectResponseSchema, await createdResponse.json());
    const repeatedResponse = await app.fetch(postJson("/projects", { gitUrl: specification }));
    const repeated = Value.Parse(projectResponseSchema, await repeatedResponse.json());
    expect(createdResponse.status).toBe(200);
    expect(repeated.project.id).toBe(created.project.id);

    const listedResponse = await app.fetch(new Request("http://test.local/projects", { headers: { accept: "application/json" } }));
    const listed = Value.Parse(projectListResponseSchema, await listedResponse.json());
    expect(listed.projects.map((project) => project.id)).toEqual([created.project.id]);

    const updatedResponse = await app.fetch(postJson(`/projects/${created.project.id}`, { name: "JSON Project", gitUrl: specification }));
    const updated = Value.Parse(projectResponseSchema, await updatedResponse.json());
    expect(updated.project.name).toBe("JSON Project");

    const environmentCreatedResponse = await app.fetch(postJson(`/projects/${created.project.id}/environment`, { name: "EMPTY_OK", value: "" }));
    const environmentCreated = Value.Parse(environmentVariableResponseSchema, await environmentCreatedResponse.json());
    const environmentUpdatedResponse = await app.fetch(postJson(`/projects/${created.project.id}/environment/${environmentCreated.environmentVariable.id}`, {
      name: "API_URL",
      value: "https://api.example",
    }));
    expect(Value.Parse(environmentVariableResponseSchema, await environmentUpdatedResponse.json()).environmentVariable)
      .toMatchObject({ name: "API_URL", value: "https://api.example" });

    const sensitive = "sensitive-value-never-return";
    const secretResponse = await app.fetch(postJson(`/projects/${created.project.id}/secrets`, {
      envName: "POETRY_API_KEY",
      hostPattern: "api.poetry.example",
      placeholder: "",
      secretValue: sensitive,
    }));
    const secretText = await secretResponse.text();
    const secretCreated = Value.Parse(projectSecretResponseSchema, JSON.parse(secretText));
    expect(secretText).not.toContain(sensitive);
    expect(secretCreated.secret).not.toHaveProperty("secretValue");

    const secretUpdateResponse = await app.fetch(postJson(`/projects/${created.project.id}/secrets/${secretCreated.secret.id}`, {
      envName: "POETRY_API_KEY",
      hostPattern: "packages.example",
      placeholder: "token",
    }));
    expect(await secretUpdateResponse.text()).not.toContain(sensitive);
    expect((await revealProjectSecrets(created.project.id))[0]?.secretValue).toBe(sensitive);

    const detailResponse = await app.fetch(new Request(`http://test.local/projects/${created.project.id}`, { headers: { accept: "application/json" } }));
    const detailText = await detailResponse.text();
    const detail = Value.Parse(projectDetailResponseSchema, JSON.parse(detailText));
    expect(detail.project.environment).toHaveLength(1);
    expect(detail.project.secrets).toHaveLength(1);
    expect(detailText).not.toContain(sensitive);
    expect(detailText).not.toContain("encryptedSecret");

    const deletedSecretResponse = await app.fetch(postJson(`/projects/${created.project.id}/secrets/${secretCreated.secret.id}/delete`, {}));
    const deletedEnvironmentResponse = await app.fetch(postJson(`/projects/${created.project.id}/environment/${environmentCreated.environmentVariable.id}/delete`, {}));
    expect(Value.Parse(deletedProjectSecretResponseSchema, await deletedSecretResponse.json()).deleted).toBe(true);
    expect(Value.Parse(deletedProjectEnvironmentVariableResponseSchema, await deletedEnvironmentResponse.json()).deleted).toBe(true);
  });

  test("project JSON routes return structured errors for malformed and invalid bodies", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);
    const malformed = await app.fetch(new Request("http://test.local/projects", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{",
    }));
    const missing = await app.fetch(postJson("/projects", {}));

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_arguments" } });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "invalid_arguments", message: "gitUrl is required" } });
  });

  test("project deletion JSON reports non-sensitive blockers and success", async () => {
    const first = (await addProject("https://github.com/org/first.git")).project;
    const second = (await addProject("https://github.com/org/second.git")).project;
    const { app, registry } = createTestApp();
    await registry.seed([{ id: "1585eff7", title: "poetry-slideshow", init: projectWorkspaceInit(first) }]);

    const blockedResponse = await app.fetch(postJson(`/projects/${first.id}/delete`, {}));
    const blocked = Value.Parse(projectDeletionBlockedResponseSchema, await blockedResponse.json());
    const deletedResponse = await app.fetch(postJson(`/projects/${second.id}/delete`, {}));

    expect(blocked).toEqual({
      deleted: false,
      blocked: true,
      references: [{ workspaceId: "1585eff7", title: "poetry-slideshow" }],
    });
    expect(deletedResponse.status).toBe(200);
    expect((await listProjects()).projects).toEqual([first]);
  });

  test("lists workspace summaries as JSON while browser requests redirect", async () => {
    const { app, registry } = createTestApp();
    const project = projectWorkspaceInit({
      id: "project-1",
      name: "demo",
      gitUrl: "https://example.test/demo.git",
      branch: null,
      sessionShareKey: "demo",
    });
    await registry.seed([{ id: "abc12345", title: "Automation target", parked: true, init: project }]);

    const json = await app.fetch(new Request("http://test.local/workspaces", { headers: { accept: "application/json" } }));
    const browser = await app.fetch(new Request("http://test.local/workspaces"));

    expect(await json.json()).toEqual({
      workspaces: [{ id: "abc12345", title: "Automation target", phase: "ready", parked: true, projectId: "project-1" }],
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("http://test.local/");
  });

  test("OpenAPI advertises the supported automation surface", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([]);

    const removed = await app.fetch(postJson("/api/workspaces", {}));
    const response = await app.fetch(new Request("http://test.local/openapi.json"));
    const specification = await response.json();

    expect(removed.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(specification).toMatchObject({
      paths: {
        "/workspaces": {},
        "/workspaces/{id}/commands/{commandId}": {},
        "/projects": {},
        "/projects/{projectId}": {},
        "/projects/{projectId}/settings": {
          get: { parameters: expect.arrayContaining([expect.objectContaining({ name: "section", in: "query" })]) },
        },
        "/projects/{projectId}/environment/{variableId}/delete": {},
        "/projects/{projectId}/secrets/{secretId}/delete": {},
        "/projects/{projectId}/delete": {},
        "/workspaces/{id}/attention/acknowledge": {
          post: { parameters: expect.arrayContaining([expect.objectContaining({ name: "attentionTokens", in: "query", required: true })]) },
        },
        "/workspaces/{id}/agents/{conversationId}/close": {
          post: { responses: {
            "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConversationCloseResult" } } } },
            "409": { content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          } },
        },
      },
      components: { schemas: { CommandResult: {
        properties: { command: { properties: { agentConversationId: { type: "string", format: "uuid" } } } },
      } } },
    });
    expect(specification).not.toMatchObject({ paths: { "/api/workspaces": expect.anything() } });
    expect(specification).not.toMatchObject({ paths: { "/workspaces/{id}/agent-conversations/{conversationId}/close": expect.anything() } });
  });
});
