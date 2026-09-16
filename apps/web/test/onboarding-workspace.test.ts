import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addProject, projectWorkspaceInitWithSettings, readProjectWorkspaceSettings, writeProjectWorkspaceSettings, isGitProjectInit } from "@atelier/projects";
import { createTestApp, deferred, temporaryAtelierDataDir, postJson, type ProvisionWorkspaceOptions } from "./support/test-web-app.ts";

const data = temporaryAtelierDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

async function init() {
  const project = (await addProject("https://github.com/example/app.git")).project;
  const config = await readProjectWorkspaceSettings(project.id);
  return projectWorkspaceInitWithSettings(project.id, config.settingsRevision, { dockerfile: "", preloadImages: ["redis:7"], environment: [] }, { workspaceId: "parent", conversationId: "agent" });
}

describe("agent workspace creation through normal provisioning", () => {
  test("creates a visible ordinary workspace, passes its snapshot and reports measured steps", async () => {
    const configuration = await init();
    const { app, registry } = createTestApp({ provision: async (id, options) => {
      expect(options.init).toEqual(configuration);
      expect(registry.get(id)?.init).toEqual(configuration);
      await options.run.step("setup", "Setup", async () => { await Bun.sleep(10); });
    } });
    const updates: any[] = [];
    const result = await app.createWorkspaceFromAgent(configuration, "", undefined, (update) => updates.push(update));
    expect(result.status).toBe("ready");
    expect(registry.get(result.workspaceId)?.phase).toBe("ready");
    expect(result.settings).toEqual(configuration.settings);
    expect(result.timings.phases).toEqual([{ id: "setup", label: "Setup", status: "done", durationMs: expect.any(Number), error: undefined }]);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(5);
    expect(updates[0].details).toEqual({ workspaceId: result.workspaceId, url: result.url });
    expect((await readProjectWorkspaceSettings(configuration.projectId)).settings.preloadImages).toEqual([]);
  });

  test("retains a failed workspace and returns its failure and timing", async () => {
    const { app, registry } = createTestApp({ provision: async (_id, options) => {
      await options.run.step("image", "Build image", () => { throw new Error("build failed"); });
    } });
    const result = await app.createWorkspaceFromAgent(await init(), "", undefined, undefined);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("build failed");
    expect(registry.get(result.workspaceId)?.phase).toBe("failed");
    expect(result.timings.phases[0]).toMatchObject({ id: "image", status: "failed", durationMs: expect.any(Number) });
  });

  test("returns a workspace awaiting normal provisioning recovery rather than hanging", async () => {
    const { app, registry } = createTestApp({ provision: async (_id, options) => {
      await options.run.step("setup", "Setup", () => { throw new Error("needs input"); }, "continue");
    } });
    const result = await app.createWorkspaceFromAgent(await init(), "", undefined, undefined);
    expect(result.status).toBe("awaiting_user");
    expect(registry.get(result.workspaceId)?.phase).toBe("starting");
    expect(result.timings.phases[0]?.error).toBe("needs input");
    app.provisioning.resume(result.workspaceId, "continue");
    await Bun.sleep(5);
    expect(registry.get(result.workspaceId)?.phase).toBe("ready");
  });

  test("cancelling the tool stops waiting without deleting or aborting the new workspace", async () => {
    const pending = deferred();
    const controller = new AbortController();
    const { app, registry } = createTestApp({ provision: async (_id, options) => {
      await options.run.step("setup", "Setup", () => pending.promise);
    } });
    const operation = app.createWorkspaceFromAgent(await init(), "", controller.signal, () => controller.abort());
    await expect(operation).rejects.toThrow();
    const workspace = registry.list()[0]!;
    expect(workspace.phase).toBe("starting");
    pending.resolve();
    await Bun.sleep(5);
    expect(registry.get(workspace.id)?.phase).toBe("ready");
  });
});

describe("project onboarding launch", () => {
  test("acceptance creates a same-project recovery workspace with a host-owned onboarding context", async () => {
    const configuration = await init();
    const before = await readProjectWorkspaceSettings(configuration.projectId);
    const saved = await writeProjectWorkspaceSettings(configuration.projectId, before.settingsRevision, {
      dockerfile: "FROM atelier-workspace\nRUN exit 1", preloadImages: ["missing-image:broken"], environment: [{ name: "PATH", value: "/broken" }],
    });
    const provisioned = deferred<ProvisionWorkspaceOptions>();
    const { app, registry } = createTestApp({ provision: async (_id, options) => { provisioned.resolve(options); } });
    const response = await app.fetch(postJson(`/projects/${configuration.projectId}/onboarding`, {}));
    expect(response.status).toBe(202);
    const { workspace } = await response.json();
    expect(response.headers.get("location")).toBe(workspace.url);
    const options = await provisioned.promise;
    expect(isGitProjectInit(options.init)).toBe(true);
    if (!isGitProjectInit(options.init)) throw new Error("Expected project init");
    expect(options.init).toMatchObject({ projectId: configuration.projectId, gitUrl: configuration.gitUrl, branch: configuration.branch,
      settings: { dockerfile: "FROM atelier-workspace", preloadImages: [], environment: [] } });
    expect(options.init.createdBy).toBeUndefined();
    expect(options.context?.projectOnboarding).toBe(true);
    expect(options.context?.agent?.initialPrompt).toContain(before.project.name);
    expect(options.context?.agent?.initialPrompt).toContain("I understand this may take a few minutes.");
    expect(registry.get(workspace.id)?.init).toEqual(options.init);
    expect((await readProjectWorkspaceSettings(configuration.projectId)).settingsRevision).toBe(saved.settingsRevision);
  });

  test("adding a project alone creates no workspace", async () => {
    const { app, registry } = createTestApp();
    expect((await app.fetch(postJson("/projects", { gitUrl: "https://example.com/declined.git" }))).status).toBe(200);
    expect(registry.list()).toEqual([]);
  });

  test("ordinary workspace parameters cannot enable onboarding or select its recovery source", async () => {
    const configuration = await init();
    const provisioned = deferred<ProvisionWorkspaceOptions>();
    const { app } = createTestApp({ provision: async (_id, options) => { provisioned.resolve(options); } });
    const response = await app.fetch(postJson("/workspaces", {
      source: { type: "project", project: configuration.projectId, projectOnboarding: true },
      projectOnboarding: true,
      agent: { initialPrompt: "Please onboard this project", projectOnboarding: true },
    }));
    expect(response.status).toBe(202);
    expect((await provisioned.promise).context?.projectOnboarding).toBeUndefined();
    expect((await app.fetch(postJson("/workspaces", { source: { type: "project-onboarding", project: configuration.projectId } }))).status).toBe(400);
  });

  test("rejects unknown projects before provisioning", async () => {
    const { app, registry } = createTestApp();
    expect((await app.fetch(postJson("/projects/missing/onboarding", {}))).status).toBe(404);
    expect(registry.list()).toEqual([]);
  });
});
