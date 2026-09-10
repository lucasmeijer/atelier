import type { JsonObject } from "@atelier/core";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, createProjectSecret, listProjectSecrets, revealProjectSecrets } from "@atelier/projects";
import { createSecretRequests, type PendingSecretRequest, type SecretSuggestion } from "../src/secret-requests.ts";
import { createAddProjectSecretTool } from "../src/tool.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let directory: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.ATELIER_DATA_DIR;
  directory = await mkdtemp(join(tmpdir(), "atelier-secret-request-"));
  process.env.ATELIER_DATA_DIR = directory;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previous;
  await rm(directory, { recursive: true, force: true });
});
const suggestion: SecretSuggestion = { envName: "apiToken", hostPattern: "api.example.com", annotation: "Sends notifications.", optional: true };
async function scenario() {
  const { project } = await addProject("https://github.com/example/secret-dialog");
  const opened = Promise.withResolvers<PendingSecretRequest>();
  const requests = createSecretRequests((workspaceId) => {
    const request = requests.forWorkspace(workspaceId);
    if (request) opened.resolve(request);
  });
  return { project, requests, opened: opened.promise };
}

test("the tool waits for edited settings and never returns the provided value", async () => {
  const { project, requests, opened } = await scenario();
  const tool = createAddProjectSecretTool({ projectId: project.id }, "setup", requests);
  // SAFETY: This tool uses only its input and abort signal, not Pi's execution context.
  const response = tool.execute("call", suggestion, undefined, undefined, {} as ExtensionContext);
  const pending = await opened;
  expect(await listProjectSecrets(project.id)).toEqual([]);
  const result = await requests.complete(pending.id, { ...suggestion, hostPattern: "notifications.example.com", annotation: "Delivers email.", optional: false }, "save", "private-value-123");
  expect(result.valueProvided).toBe(true);
  expect(result.secret.configured).toBe(true);
  expect(result.changedFields).toEqual(["hostPattern", "annotation", "optional"]);
  expect((await revealProjectSecrets(project.id))[0]?.secretValue).toBe("private-value-123");
  expect(JSON.stringify(await response)).not.toContain("private-value-123");
  expect(requests.forWorkspace("setup")).toBeUndefined();
});

test("deferring still saves the edited definition without a value, ignoring any typed value", async () => {
  const { project, requests, opened } = await scenario();
  const response = requests.request("setup", project.id, suggestion);
  const pending = await opened;
  await requests.complete(pending.id, { ...suggestion, envName: "renamedToken" }, "skip", "must-not-save");
  const result = await response;
  expect(result.secret).toMatchObject({ envName: "renamedToken", configured: false });
  expect(result.valueProvided).toBe(false);
  expect(result.changedFields).toEqual(["envName"]);
  expect(await listProjectSecrets(project.id)).toHaveLength(1);
  expect(await revealProjectSecrets(project.id)).toEqual([]);
});

test("saving requires a value and invalid submissions leave the request awaiting a decision", async () => {
  const { project, requests, opened } = await scenario();
  const response = requests.request("setup", project.id, suggestion);
  const pending = await opened;
  await expect(requests.complete(pending.id, suggestion, "save", "")).rejects.toThrow("Enter a secret value");
  await expect(requests.complete(pending.id, { ...suggestion, envName: "not valid" }, "skip", "")).rejects.toThrow();
  expect(requests.forWorkspace("setup")?.id).toBe(pending.id);
  expect(await listProjectSecrets(project.id)).toEqual([]);
  await requests.complete(pending.id, suggestion, "skip", "");
  await response;
});

test("editing an existing secret updates its identity and preserves its value when deferred", async () => {
  const { project, requests, opened } = await scenario();
  const existing = await createProjectSecret(project.id, { ...suggestion, secretValue: "keep-private" });
  const response = requests.request("setup", project.id, suggestion);
  const pending = await opened;
  await requests.complete(pending.id, { ...suggestion, envName: "newName" }, "skip", "");
  const result = await response;
  expect(result.secret).toMatchObject({ id: existing.id, envName: "newName", configured: true });
  expect(result.valueProvided).toBe(false);
  expect((await revealProjectSecrets(project.id))[0]?.secretValue).toBe("keep-private");
  expect(JSON.stringify(result)).not.toContain("keep-private");
});

test("requests are one-at-a-time, cancellable, and stale decisions cannot save secrets", async () => {
  const { project, requests, opened } = await scenario();
  const abort = new AbortController();
  const response = requests.request("setup", project.id, suggestion, abort.signal);
  const pending = await opened;
  await expect(requests.request("setup", project.id, suggestion)).rejects.toThrow("Finish the current");
  abort.abort();
  await expect(response).rejects.toThrow("cancelled");
  await expect(requests.complete(pending.id, suggestion, "save", "too-late")).rejects.toThrow("no longer active");
  expect(await listProjectSecrets(project.id)).toEqual([]);
});

test("workspace removal releases the waiting tool without saving a secret", async () => {
  const { project, requests, opened } = await scenario();
  const response = requests.request("setup", project.id, suggestion);
  await opened;
  requests.cancelWorkspace("setup");
  await expect(response).rejects.toThrow("workspace was removed");
  expect(await listProjectSecrets(project.id)).toEqual([]);
});

test("JSON decisions validate input and workspace ownership, and return no secret value", async () => {
  const { secretRequestRoutes } = await import("../src/server/secret-dialog.ts");
  const { project, requests, opened } = await scenario();
  const response = requests.request("setup", project.id, suggestion);
  const pending = await opened;
  const routes = secretRequestRoutes(requests);
  const context = { openWorkView: async () => { throw new Error("Not used"); }, renderModalPage: async () => { throw new Error("Not used"); } };
  function submit(workspaceId: string, body: JsonObject) {
    const url = new URL(`http://localhost/workspaces/${workspaceId}/project-setup/secret-request/${pending.id}`);
    return routes.handle(new Request(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) }), url, context);
  }
  await expect(submit("other-workspace", { ...suggestion, decision: "save", secretValue: "private" })).rejects.toThrow("does not belong");
  await expect(submit("setup", { ...suggestion, decision: "save", secretValue: { invalid: true } })).rejects.toThrow("valid secret settings");
  const saved = await submit("setup", { ...suggestion, decision: "save", secretValue: "private" });
  expect(saved?.status).toBe(200);
  const text = await saved!.text();
  expect(text).not.toContain("private");
  expect(JSON.parse(text)).toMatchObject({ valueProvided: true, secret: { configured: true } });
  await response;
});

test("the secret tool rejects model-supplied values and project overrides", async () => {
  const { project, requests } = await scenario();
  const tool = createAddProjectSecretTool({ projectId: project.id }, "setup", requests);
  for (const extra of [{ secretValue: "never-accept" }, { projectId: "other" }]) {
    // SAFETY: This tool does not access Pi's execution context.
    await expect(tool.execute("call", { ...suggestion, ...extra }, undefined, undefined, {} as ExtensionContext)).rejects.toThrow();
  }
  expect(requests.forWorkspace("setup")).toBeUndefined();
});
