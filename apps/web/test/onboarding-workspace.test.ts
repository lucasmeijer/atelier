import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addProject, projectWorkspaceInitWithSettings, readProjectWorkspaceSettings } from "@atelier/projects";
import { createTestApp, deferred, temporaryAtelierDataDir } from "./support/test-web-app.ts";

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
