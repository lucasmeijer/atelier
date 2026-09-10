import { createAtelierEventBus, getAtelierRuntimeContext, dockerHostAtelierDataPath, type AtelierEventMap, type JsonObject } from "@atelier/core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addProject, createProjectEnvironmentVariable, createProjectSecret, revealProjectSecrets, getProjectConfiguration, listProjectEnvironmentVariables, listProjectSecrets } from "@atelier/projects";
import { projectSetupWorkspace } from "../src/index.ts";
import { createSetProjectDockerfileTool } from "../src/tool.ts";

// Model calls are untrusted JSON. These tools do not use Pi's execution context.
function execute(tool: ToolDefinition<any, any>, input: JsonObject) {
  // SAFETY: The project setup callback does not access Pi’s execution context.
  return tool.execute("call", input, undefined, undefined, {} as ExtensionContext);
}

let dataDir: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ATELIER_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "atelier-project-setup-"));
  process.env.ATELIER_DATA_DIR = dataDir;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previous;
  await rm(dataDir, { recursive: true, force: true });
});

test("setup owns the title, prompt and project-bound tool without a task kind", async () => {
  const { project } = await addProject("https://github.com/example/repo#develop");
  const setup = projectSetupWorkspace(project);
  expect(setup.source).toEqual({ type: "empty" });
  expect(setup.title).toBe(`Set up ${project.name}`);
  expect(setup.agent.initialPrompt).toContain("https://github.com/example/repo#develop");
  expect(setup.agent.initialPrompt).toContain("/opt/atelier/project-setup/configure-user-project.md");
  expect(setup.agent.additionalTools).toEqual(["add_project_secret", "add_project_settings_environment_variable", "set_project_settings_dockerfile"].map((name) => ({ name, context: { projectId: project.id } })));
});

test("the Dockerfile tool changes only its bound project's Dockerfile", async () => {
  const { project } = await addProject("https://github.com/example/repo");
  const other = (await addProject("https://github.com/example/other")).project;
  await createProjectEnvironmentVariable(project.id, { name: "PORT", value: "3000" });
  await createProjectSecret(project.id, { envName: "EXISTING", hostPattern: "api.example.com", secretValue: "preserve-me" });
  const tool = createSetProjectDockerfileTool({ projectId: project.id });
  const result = await execute(tool, { dockerfile: "FROM atelier-workspace\nRUN apt-get update" });
  expect((await getProjectConfiguration(project.id)).dockerfile).toContain("FROM atelier-workspace");
  expect((await getProjectConfiguration(other.id)).dockerfile).toBeUndefined();
  expect((await listProjectEnvironmentVariables(project.id)).map(({ name, value }) => ({ name, value }))).toEqual([{ name: "PORT", value: "3000" }]);
  expect((await revealProjectSecrets(project.id))[0]?.secretValue).toBe("preserve-me");
  expect(result.details).toEqual({ projectId: project.id, settingsUrl: `/projects/${project.id}/settings?section=dockerfile` });
  await execute(tool, { dockerfile: "" });
  expect((await getProjectConfiguration(project.id)).dockerfile).toBeUndefined();
});

test("the Dockerfile tool rejects invalid content, bulk settings, and project overrides", async () => {
  const { project } = await addProject("https://github.com/example/repo");
  const tool = createSetProjectDockerfileTool({ projectId: project.id });
  await expect(execute(tool, { dockerfile: "FROM ubuntu" })).rejects.toThrow("Dockerfile must start");
  await expect(execute(tool, { dockerfile: "FROM atelier-workspace", projectId: "other" })).rejects.toThrow();
  await expect(execute(tool, { dockerfile: "FROM atelier-workspace", environment: [], secrets: [] })).rejects.toThrow();
  expect((await getProjectConfiguration(project.id)).dockerfile).toBeUndefined();
  expect(await listProjectSecrets(project.id)).toEqual([]);
});

test("the workspace-plan hook mounts the module guide read-only in every workspace", async () => {
  const { atelierServerModule } = await import("../src/server/index.ts");
  const events = createAtelierEventBus();
  await atelierServerModule.initialize({ events, broadcastWorkspace() {}, onWorkspaceRemoved() {} });
  for (const workspaceId of ["setup-workspace", "ordinary-workspace"]) {
    const event: AtelierEventMap["workspace_plan_prepare"] = {
      workspaceId, workHostPath: join(dataDir, "work"), workContainerPath: "/work",
      plan: { labels: {}, env: {}, mounts: [], publishes: [], extraArgs: [], initScripts: [], containerFiles: [], cleanup: [] },
    };
    await events.emit("workspace_plan_prepare", event);
    expect(event.plan.mounts).toEqual([{
      type: "bind", source: dockerHostAtelierDataPath(getAtelierRuntimeContext(), "project-setup"),
      target: "/opt/atelier/project-setup", readonly: true,
    }]);
  }
  expect(await Bun.file(join(dataDir, "project-setup", "configure-user-project.md")).text()).toBe(await Bun.file(new URL("../docs/configure-user-project.md", import.meta.url)).text());
});

