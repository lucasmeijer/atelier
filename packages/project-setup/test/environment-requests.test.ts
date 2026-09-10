import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, createProjectEnvironmentVariable, listProjectEnvironmentVariables } from "@atelier/projects";
import { createEnvironmentRequests, type PendingEnvironmentRequest } from "../src/environment-requests.ts";
import { createAddProjectEnvironmentVariableTool } from "../src/tool.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let directory: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ATELIER_DATA_DIR;
  directory = await mkdtemp(join(tmpdir(), "atelier-environment-request-"));
  process.env.ATELIER_DATA_DIR = directory;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previous;
  await rm(directory, { recursive: true, force: true });
});
const suggestion = { name: "appPort", value: "3000" };
async function scenario() {
  const { project } = await addProject("https://github.com/example/environment-dialog");
  const opened = Promise.withResolvers<PendingEnvironmentRequest>();
  const requests = createEnvironmentRequests((workspaceId) => {
    const request = requests.forWorkspace(workspaceId);
    if (request) opened.resolve(request);
  });
  return { project, requests, opened: opened.promise };
}

test("the environment tool waits for permission and saves the user's edited variable", async () => {
  const { project, requests, opened } = await scenario();
  const tool = createAddProjectEnvironmentVariableTool({ projectId: project.id }, "setup", requests);
  // SAFETY: The tool uses only input and abort signal, not Pi's execution context.
  const response = tool.execute("call", suggestion, undefined, undefined, {} as ExtensionContext);
  const pending = await opened;
  expect(await listProjectEnvironmentVariables(project.id)).toEqual([]);
  await requests.complete(pending.id, { name: "httpPort", value: "4000" }, "save");
  expect((await response).details).toEqual({ saved: true, settings: { name: "httpPort", value: "4000" }, changedFields: ["name", "value"] });
  expect((await listProjectEnvironmentVariables(project.id))[0]).toMatchObject({ name: "httpPort", value: "4000" });
});

test("declining an environment variable leaves settings unchanged", async () => {
  const { project, requests, opened } = await scenario();
  const existing = await createProjectEnvironmentVariable(project.id, suggestion);
  const response = requests.request("setup", project.id, suggestion);
  const pending = await opened;
  await requests.complete(pending.id, { name: "", value: "changed" }, "skip");
  expect((await response).saved).toBe(false);
  expect(await listProjectEnvironmentVariables(project.id)).toEqual([existing]);
});

test("approving updates the suggested existing variable and permits an empty value", async () => {
  const { project, requests, opened } = await scenario();
  const existing = await createProjectEnvironmentVariable(project.id, suggestion);
  const response = requests.request("setup", project.id, suggestion);
  const pending = await opened;
  await requests.complete(pending.id, { name: "newName", value: "" }, "save");
  expect((await response).saved).toBe(true);
  expect(await listProjectEnvironmentVariables(project.id)).toMatchObject([{ id: existing.id, name: "newName", value: "" }]);
});

test("invalid names leave the approval open; cancellation saves nothing", async () => {
  const { project, requests, opened } = await scenario();
  const signal = new AbortController();
  const response = requests.request("setup", project.id, suggestion, signal.signal);
  const pending = await opened;
  await expect(requests.complete(pending.id, { name: "invalid name", value: "3000" }, "save")).rejects.toThrow();
  expect(requests.forWorkspace("setup")?.id).toBe(pending.id);
  signal.abort();
  await expect(response).rejects.toThrow("cancelled");
  expect(await listProjectEnvironmentVariables(project.id)).toEqual([]);
  await expect(requests.complete(pending.id, suggestion, "save")).rejects.toThrow("no longer active");
});

test("environment approval JSON is workspace-scoped and skipping saves nothing", async () => {
  const { environmentRequestRoutes } = await import("../src/server/environment-dialog.ts");
  const { project, requests, opened } = await scenario();
  const response = requests.request("setup", project.id, suggestion);
  const pending = await opened;
  const routes = environmentRequestRoutes(requests);
  const context = { openWorkView: async () => { throw new Error("Not used"); }, renderModalPage: async () => { throw new Error("Not used"); } };
  function submit(workspaceId: string) {
    const url = new URL(`http://localhost/workspaces/${workspaceId}/project-setup/environment-request/${pending.id}`);
    return routes.handle(new Request(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ ...suggestion, decision: "skip" }) }), url, context);
  }
  await expect(submit("another-workspace")).rejects.toThrow("does not belong");
  const result = await submit("setup");
  expect(result?.status).toBe(200);
  expect(await result!.json()).toEqual({ saved: false, settings: suggestion, changedFields: [] });
  expect((await response).saved).toBe(false);
  expect(await listProjectEnvironmentVariables(project.id)).toEqual([]);
});
