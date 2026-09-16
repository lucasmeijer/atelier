import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JsonObject } from "@atelier/core";
import { addProject, createProjectSecret, getProjectConfiguration, listProjectSecrets, readProjectWorkspaceSettings, revealProjectSecrets, updateProjectSecret, projectSecretRoutingRevision } from "@atelier/projects";
import { createTestApp, postJson, temporaryAtelierDataDir } from "./support/test-web-app.ts";

const data = temporaryAtelierDataDir();
beforeEach(data.setUp);
afterEach(data.tearDown);

async function fixture() {
  const project = (await addProject("https://github.com/example/secret-entry.git")).project;
  const secret = await createProjectSecret(project.id, { envName: "API_TOKEN", hostPattern: "api.example.com", placeholder: "placeholder-token", annotation: "Check account access", optional: true });
  return { project, secret, path: `/projects/${project.id}/secrets/${secret.id}/value`, ...createTestApp() };
}

describe("value-only project secret entry", () => {
  test("saves and replaces encrypted values, advances revision, and never returns the value", async () => {
    const { app, project, secret, path } = await fixture();
    const initial = await readProjectWorkspaceSettings(project.id);
    for (const secretValue of ["first-private-value", "replacement-private-value"]) {
      const response = await app.fetch(postJson(path, { secretValue, expectedRoutingRevision: projectSecretRoutingRevision(secret) }));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.secret).toMatchObject({ id: secret.id, configured: true, envName: secret.envName, hostPattern: secret.hostPattern, placeholder: secret.placeholder, annotation: secret.annotation, optional: true });
      expect(JSON.stringify(result)).not.toContain(secretValue);
      expect(JSON.stringify(result)).not.toContain("encryptedSecret");
      expect((await revealProjectSecrets(project.id))[0]?.secretValue).toBe(secretValue);
    }
    expect((await readProjectWorkspaceSettings(project.id)).settingsRevision).not.toBe(initial.settingsRevision);
  });

  test("preserves non-routing metadata edited while the dialog was open", async () => {
    const { app, project, secret, path } = await fixture();
    await updateProjectSecret(project.id, secret.id, { envName: secret.envName, hostPattern: secret.hostPattern, placeholder: secret.placeholder, annotation: "New purpose", optional: false });
    const before = (await getProjectConfiguration(project.id)).secrets[0]!;
    const response = await app.fetch(postJson(path, { secretValue: "private-value", expectedRoutingRevision: projectSecretRoutingRevision(secret) }));
    expect(response.status).toBe(200);
    const after = (await listProjectSecrets(project.id))[0]!;
    expect(after).toMatchObject({ envName: before.envName, hostPattern: before.hostPattern, placeholder: before.placeholder, annotation: before.annotation, optional: before.optional });
  });

  test("the form submits only a value and preserves its exact contents", async () => {
    const { app, project, secret, path } = await fixture();
    const secretValue = "  token-with-significant-spaces  ";
    const response = await app.fetch(new Request(`http://test.local${path}`, { method: "POST", headers: { accept: "text/vnd.turbo-stream.html" }, body: new URLSearchParams({ secretValue, expectedRoutingRevision: projectSecretRoutingRevision(secret) }) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect((await revealProjectSecrets(project.id))[0]?.secretValue).toBe(secretValue);
  });

  test("rejects a stale routing confirmation before storing a new credential", async () => {
    const { app, project, secret, path } = await fixture();
    const revision = projectSecretRoutingRevision(secret);
    await updateProjectSecret(project.id, secret.id, { envName: secret.envName, hostPattern: "changed.example.com" });
    const response = await app.fetch(postJson(path, { secretValue: "must-not-be-saved", expectedRoutingRevision: revision }));
    expect(response.status).toBe(409);
    expect(await revealProjectSecrets(project.id)).toEqual([]);
    expect((await listProjectSecrets(project.id))[0]?.hostPattern).toBe("changed.example.com");
  });

  test("rejects a form without routing confirmation", async () => {
    const { app, project, path } = await fixture();
    const response = await app.fetch(new Request(`http://test.local${path}`, { method: "POST", headers: { accept: "text/vnd.turbo-stream.html" }, body: new URLSearchParams({ secretValue: "must-not-be-saved" }) }));
    expect(response.status).toBe(400);
    expect(await revealProjectSecrets(project.id)).toEqual([]);
  });

  test("rejects missing, empty and metadata-bearing JSON input without changing the project", async () => {
    const { app, project, secret, path } = await fixture();
    const initial = await readProjectWorkspaceSettings(project.id);
    const expectedRoutingRevision = projectSecretRoutingRevision(secret);
    const inputs: JsonObject[] = [{}, { secretValue: "private" }, { secretValue: "", expectedRoutingRevision }, { secretValue: "   ", expectedRoutingRevision }, { secretValue: "private", hostPattern: "evil.example", expectedRoutingRevision }];
    for (const input of inputs) {
      expect((await app.fetch(postJson(path, input))).status).toBe(400);
      expect(await readProjectWorkspaceSettings(project.id)).toEqual(initial);
    }
  });

  test("cannot save another project's secret by mixing project and secret IDs", async () => {
    const { app, project, secret } = await fixture();
    const other = (await addProject("https://github.com/example/other.git")).project;
    const response = await app.fetch(postJson(`/projects/${other.id}/secrets/${secret.id}/value`, { secretValue: "private", expectedRoutingRevision: projectSecretRoutingRevision(secret) }));
    expect(response.status).toBe(404);
    expect((await listProjectSecrets(project.id))[0]?.configured).toBe(false);
  });
});
