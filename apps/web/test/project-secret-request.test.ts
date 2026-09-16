import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, createProjectSecret, deleteProjectSecret, listProjectSecrets, readProjectWorkspaceSettings, revealProjectSecrets, updateProjectSecret, setProjectSecretValue, projectSecretRoutingRevision } from "@atelier/projects";
import { createProjectSecretRequester } from "../src/server/project-secret-request.ts";

const request = { envName: "NPM_TOKEN", hostPattern: "registry.npmjs.org", purpose: "Install private dependencies" };

describe("secure project secret requests", () => {
  let dir: string;
  let previous: string | undefined;
  let projectId: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atelier-secret-request-"));
    previous = process.env.ATELIER_DATA_DIR;
    process.env.ATELIER_DATA_DIR = dir;
    projectId = (await addProject("https://github.com/example/app.git")).project.id;
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  function requester(wait: () => Promise<void>) {
    return createProjectSecretRequester({ list: listProjectSecrets, create: createProjectSecret, readSettings: readProjectWorkspaceSettings, wait });
  }

  test("requests secure entry, persists immediately, advances revision and returns only placeholder metadata", async () => {
    const initial = await readProjectWorkspaceSettings(projectId);
    const updates: any[] = [];
    const ask = requester(async () => {
      const [secret] = await listProjectSecrets(projectId);
      expect(secret?.configured).toBe(false);
      expect(secret?.annotation).toBe(request.purpose);
      await setProjectSecretValue(projectId, secret!.id, { secretValue: "very-private-token", expectedRoutingRevision: projectSecretRoutingRevision(secret!) });
      expect((await revealProjectSecrets(projectId))[0]?.secretValue).toBe("very-private-token");
    });
    const result = await ask(projectId, request, undefined, (update) => updates.push(update));
    expect(result).toMatchObject({ status: "saved", envName: "NPM_TOKEN", placeholder: "ATELIER_PROXY_READY_NPM_TOKEN", egressReplacement: "active_for_new_connections", reconnectRequired: true, existingProcessEnvironmentUpdated: false });
    expect(result.status === "saved" && result.settingsRevision).not.toBe(initial.settingsRevision);
    expect(JSON.stringify([result, updates])).not.toContain("very-private-token");
    const secret = (await listProjectSecrets(projectId))[0]!;
    const requestUrl = new URL(updates[0].details.secretRequestUrl, "http://atelier.local");
    expect(requestUrl.pathname).toBe(`/projects/${projectId}/secrets/${secret.id}/value`);
    expect(requestUrl.searchParams.get("purpose")).toBe(request.purpose);
  });

  test("replacements wait for a value change, not an unrelated metadata edit", async () => {
    const secret = await createProjectSecret(projectId, { ...request, secretValue: "original" });
    let waits = 0;
    const ask = requester(async () => {
      waits++;
      await updateProjectSecret(projectId, secret.id, waits === 1 ? { ...request, annotation: "Edited annotation" } : { ...request, secretValue: "replacement" });
    });
    await ask(projectId, request, undefined, undefined);
    expect(waits).toBe(2);
    expect((await revealProjectSecrets(projectId))[0]?.secretValue).toBe("replacement");
    expect(await listProjectSecrets(projectId)).toHaveLength(1);
  });

  test.each([
    { hostPattern: "old.example.com" },
    { hostPattern: request.hostPattern, placeholder: "old-placeholder" },
  ])("rejects existing secrets with conflicting routing before asking for a value: %j", async (routing) => {
    await createProjectSecret(projectId, { ...request, ...routing, secretValue: "original" });
    const initial = await readProjectWorkspaceSettings(projectId);
    const ask = requester(async () => { throw new Error("Must not wait for input"); });
    const updates: any[] = [];
    await expect(ask(projectId, request, undefined, (update) => updates.push(update))).rejects.toThrow("different host restrictions or placeholder");
    expect(updates).toEqual([]);
    expect(await readProjectWorkspaceSettings(projectId)).toEqual(initial);
    expect((await revealProjectSecrets(projectId))[0]?.secretValue).toBe("original");
  });

  test("equivalent host lists and an explicitly matching custom placeholder can reuse a secret", async () => {
    const secret = await createProjectSecret(projectId, { ...request, hostPattern: "registry.npmjs.org, *.example.com", placeholder: "custom-placeholder" });
    const ask = requester(async () => { await setProjectSecretValue(projectId, secret.id, { secretValue: "replacement", expectedRoutingRevision: projectSecretRoutingRevision(secret) }); });
    const result = await ask(projectId, { ...request, hostPattern: " *.EXAMPLE.com ; registry.npmjs.org;registry.npmjs.org ", placeholder: "custom-placeholder" }, undefined, undefined);
    expect(result).toMatchObject({ placeholder: "custom-placeholder", hostPattern: "registry.npmjs.org, *.example.com" });
  });

  test("detects routing changes while a request waits instead of claiming the requested destination is ready", async () => {
    const secret = await createProjectSecret(projectId, request);
    const ask = requester(async () => { await updateProjectSecret(projectId, secret.id, { ...request, hostPattern: "other.example.com" }); });
    await expect(ask(projectId, request, undefined, undefined)).rejects.toThrow("different host restrictions or placeholder");
    expect((await listProjectSecrets(projectId))[0]?.configured).toBe(false);
  });

  test("stopping cancels waiting without deleting the project secret", async () => {
    const controller = new AbortController();
    const ask = requester(async () => { controller.abort(); });
    await expect(ask(projectId, request, controller.signal, undefined)).rejects.toThrow();
    expect((await listProjectSecrets(projectId))[0]?.configured).toBe(false);
  });

  test("removing the requested entry cancels the request", async () => {
    const ask = requester(async () => {
      const [secret] = await listProjectSecrets(projectId);
      await deleteProjectSecret(projectId, secret!.id);
    });
    expect(await ask(projectId, request, undefined, undefined)).toEqual({ status: "cancelled", envName: "NPM_TOKEN" });
  });
});
