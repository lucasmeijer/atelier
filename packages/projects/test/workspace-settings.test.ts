import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceDockerPlan } from "@atelier/workspace";
import { addProject, createProjectSecret, getProjectConfiguration, isGitProjectInit, projectWorkspaceInitWithSettings, readProjectWorkspaceSettings, registerProjectWorkspaceInitEvents, setProjectPreloadImages, updateProjectSecret, validateProjectWorkspaceSettings, writeProjectWorkspaceSettings, type ProjectWorkspaceSettings } from "../src/index.ts";

const defaults: ProjectWorkspaceSettings = { dockerfile: "", preloadImages: [], environment: [] };

describe("complete project workspace settings", () => {
  let dir: string;
  let previous: string | undefined;
  let projectId: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atelier-workspace-settings-"));
    previous = process.env.ATELIER_DATA_DIR;
    process.env.ATELIER_DATA_DIR = dir;
    projectId = (await addProject("https://github.com/example/app.git#main")).project.id;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  test("reads a complete configuration and never exposes secret values or ciphertext", async () => {
    await createProjectSecret(projectId, { envName: "TOKEN", hostPattern: "api.example.com", secretValue: "private-credential" });
    const result = await readProjectWorkspaceSettings(projectId);
    expect(result.settings).toEqual(defaults);
    expect(result.project.branch).toBe("main");
    expect(result.secrets).toEqual([{ envName: "TOKEN", hostPattern: "api.example.com", placeholder: "ATELIER_PROXY_READY_TOKEN", configured: true }]);
    expect(JSON.stringify(result)).not.toContain("private-credential");
    expect(JSON.stringify(result)).not.toContain("encryptedSecret");
  });

  test("replaces all writable settings atomically without affecting secrets or another project", async () => {
    const other = (await addProject("https://github.com/example/other.git")).project;
    const secret = await createProjectSecret(projectId, { envName: "TOKEN", hostPattern: "api.example.com", secretValue: "private-credential" });
    const initial = await readProjectWorkspaceSettings(projectId);
    const settings = { dockerfile: "FROM atelier-workspace\nRUN echo custom", preloadImages: ["postgres:17"], environment: [{ name: "PORT", value: "3000" }] };
    const saved = await writeProjectWorkspaceSettings(projectId, initial.settingsRevision, settings);
    expect(saved.settings).toEqual(settings);
    expect(saved.settingsRevision).not.toBe(initial.settingsRevision);
    const configuration = await getProjectConfiguration(projectId);
    expect(configuration.secrets[0]?.id).toBe(secret.id);
    expect(configuration.gitUrl).toBe(initial.project.gitUrl);
    expect((await readProjectWorkspaceSettings(other.id)).settings).toEqual(defaults);
    await expect(writeProjectWorkspaceSettings(projectId, initial.settingsRevision, defaults)).rejects.toThrow("configuration changed");
    expect((await readProjectWorkspaceSettings(projectId)).settings).toEqual(settings);
    const cleared = await writeProjectWorkspaceSettings(projectId, saved.settingsRevision, defaults);
    expect(cleared.settings).toEqual(defaults);
  });

  test("concurrent writers cannot both replace the same revision", async () => {
    const { settingsRevision } = await readProjectWorkspaceSettings(projectId);
    const results = await Promise.allSettled([
      writeProjectWorkspaceSettings(projectId, settingsRevision, { ...defaults, preloadImages: ["postgres:17"] }),
      writeProjectWorkspaceSettings(projectId, settingsRevision, { ...defaults, preloadImages: ["redis:7"] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("preloads and secret value changes advance the revision", async () => {
    const initial = await readProjectWorkspaceSettings(projectId);
    await setProjectPreloadImages(projectId, ["redis:7"]);
    const preload = await readProjectWorkspaceSettings(projectId);
    expect(preload.settingsRevision).not.toBe(initial.settingsRevision);
    const secret = await createProjectSecret(projectId, { envName: "TOKEN", hostPattern: "api.example.com", secretValue: "first" });
    const firstSecret = await readProjectWorkspaceSettings(projectId);
    expect(firstSecret.settingsRevision).not.toBe(preload.settingsRevision);
    await updateProjectSecret(projectId, secret.id, { envName: "TOKEN", hostPattern: "api.example.com", secretValue: "second" });
    expect((await readProjectWorkspaceSettings(projectId)).settingsRevision).not.toBe(firstSecret.settingsRevision);
    await expect(writeProjectWorkspaceSettings(projectId, preload.settingsRevision, defaults)).rejects.toThrow("configuration changed");
  });

  test("rejects invalid or incomplete settings, repository overrides, duplicates and secret collisions", async () => {
    for (const settings of [
      { ...defaults, dockerfile: "FROM ubuntu" },
      { ...defaults, preloadImages: ["https://example.com/image"] },
      { ...defaults, environment: [{ name: "BAD-NAME", value: "x" }] },
      { ...defaults, environment: [{ name: "A", value: "1" }, { name: "A", value: "2" }] },
      { ...defaults, gitUrl: "https://evil.example/repo.git" },
    ]) expect(() => validateProjectWorkspaceSettings(settings)).toThrow();
    await createProjectSecret(projectId, { envName: "TOKEN", hostPattern: "api.example.com" });
    const { settingsRevision } = await readProjectWorkspaceSettings(projectId);
    await expect(writeProjectWorkspaceSettings(projectId, settingsRevision, { ...defaults, environment: [{ name: "TOKEN", value: "secret" }] })).rejects.toThrow("managed as a secret");
    expect((await readProjectWorkspaceSettings(projectId)).settingsRevision).toBe(settingsRevision);
  });

  test("workspace configuration is an independent persisted snapshot with fixed repository and creator", async () => {
    const initial = await readProjectWorkspaceSettings(projectId);
    const settings = { ...defaults, preloadImages: ["postgres:17"], environment: [{ name: "PORT", value: "4000" }] };
    const init = await projectWorkspaceInitWithSettings(projectId, initial.settingsRevision, settings, { workspaceId: "parent", conversationId: "agent-1" });
    expect(isGitProjectInit(JSON.parse(JSON.stringify(init)))).toBe(true);
    expect(init).toMatchObject({ projectId, gitUrl: initial.project.gitUrl, branch: "main", createdBy: { workspaceId: "parent", conversationId: "agent-1" } });
    settings.preloadImages.push("redis:7");
    expect(init.settings?.preloadImages).toEqual(["postgres:17"]);
    expect(await readProjectWorkspaceSettings(projectId)).toEqual(initial);
    await setProjectPreloadImages(projectId, ["redis:7"]);
    await expect(projectWorkspaceInitWithSettings(projectId, initial.settingsRevision, defaults, { workspaceId: "parent", conversationId: "agent-1" })).rejects.toThrow("configuration changed");

    const events = createAtelierEventBus();
    registerProjectWorkspaceInitEvents(events);
    const image = { init, dockerfile: "should be replaced" };
    await events.emit("workspace_image_configure", image);
    expect(image.dockerfile).toBe("");
    const plan: WorkspaceDockerPlan = { preloadImages: [], labels: {}, env: {}, mounts: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };
    await events.emit("workspace_plan_prepare", { workspaceId: "snapshot", init, workHostPath: "/unused", workContainerPath: "/work", plan });
    expect(plan.preloadImages).toEqual(["postgres:17"]);
    expect(plan.env.PORT).toBe("4000");
    const current = await readProjectWorkspaceSettings(projectId);
    await writeProjectWorkspaceSettings(projectId, current.settingsRevision, init.settings!);
    expect((await getProjectConfiguration(projectId)).configurationFingerprint).toBe(init.configurationFingerprint);
  });
});
