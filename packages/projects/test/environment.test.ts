import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAtelierEventBus } from "@atelier/core";
import { addProject, createProjectEnvironmentVariable, projectWorkspaceInit, registerProjectWorkspaceInitEvents } from "@atelier/projects";
import type { WorkspaceDockerPlan } from "@atelier/workspace";

describe("project environment", () => {
  let previousDataDir: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    dataDir = await mkdtemp(`${tmpdir()}/atelier-project-environment-`);
    process.env.ATELIER_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("adds saved variables to project workspace container plans", async () => {
    const project = (await addProject("https://github.com/org/repo.git")).project;
    await createProjectEnvironmentVariable(project.id, { name: "API_URL", value: "https://api.example.com" });
    await createProjectEnvironmentVariable(project.id, { name: "EMPTY", value: "" });
    const events = createAtelierEventBus();
    registerProjectWorkspaceInitEvents(events);
    const plan: WorkspaceDockerPlan = { labels: {}, env: {}, mounts: [], publishes: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] };

    await events.emit("workspace_plan_prepare", { workspaceId: "workspace", init: projectWorkspaceInit(project), workHostPath: "/tmp/work", workContainerPath: "/work", plan });

    expect(plan.env).toEqual({ API_URL: "https://api.example.com", EMPTY: "" });
  });
});
