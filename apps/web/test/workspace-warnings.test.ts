import { afterEach, beforeEach, expect, test } from "bun:test";
import { addProject, createProjectEnvironmentVariable, createProjectSecret, deleteProjectEnvironmentVariable, deleteProjectSecret, getProjectConfiguration, isGitProjectInit, listProjects, projectWorkspaceInit, setProjectDockerfile, updateProjectSecret } from "@atelier/projects";
import { workspaceWarnings } from "../src/server/workspace-warnings.ts";
import type { WorkspaceEntry } from "../src/server/workspace-registry.ts";
import { temporaryAtelierDataDir } from "./support/test-web-app.ts";

const dataDir = temporaryAtelierDataDir();
beforeEach(dataDir.setUp);
afterEach(dataDir.tearDown);

function entry(init?: WorkspaceEntry["init"]): WorkspaceEntry {
  return { id: "example", title: null, phase: "ready", parked: false, imageOutdated: false, lastActivityAt: 0, init };
}

async function warningsFor(workspace: WorkspaceEntry) {
  return workspaceWarnings(workspace, isGitProjectInit(workspace.init) ? await getProjectConfiguration(workspace.init.projectId) : undefined);
}

test("setup changes are compared to creation, survive reconstruction, and reverting removes the condition", async () => {
  const { project } = await addProject("https://github.com/org/example.git");
  const workspace = entry(projectWorkspaceInit(project));
  expect(await warningsFor(workspace)).toEqual([]);
  const variable = await createProjectEnvironmentVariable(project.id, { name: "REGION", value: "eu" });
  const changed = await warningsFor(workspace);
  expect(changed.map((warning) => warning.kind)).toEqual(["project-settings-changed"]);
  expect(await warningsFor(entry(JSON.parse(JSON.stringify(workspace.init))))).toEqual(changed);
  expect(await warningsFor(entry(projectWorkspaceInit((await listProjects()).projects[0]!)))).toEqual([]);
  await deleteProjectEnvironmentVariable(project.id, variable.id);
  expect(await warningsFor(workspace)).toEqual([]);
  await setProjectDockerfile(project.id, "FROM atelier-workspace\nRUN echo ready");
  expect((await warningsFor(workspace))[0]!.state).not.toBe(changed[0]!.state);
});

test("missing mandatory secrets and changed settings are separate, while annotations are live metadata", async () => {
  const { project } = await addProject("https://github.com/org/example.git");
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const secret = await createProjectSecret(project.id, values);
  const workspace = entry(projectWorkspaceInit((await listProjects()).projects[0]!));
  expect((await warningsFor(workspace)).map((warning) => warning.kind)).toEqual(["missing-secrets"]);
  await updateProjectSecret(project.id, secret.id, { ...values, annotation: "Tests", optional: true });
  expect(await warningsFor(workspace)).toEqual([]);
  await updateProjectSecret(project.id, secret.id, { ...values, secretValue: "never expose this" });
  const warnings = await warningsFor(workspace);
  expect(warnings.map((warning) => warning.kind)).toEqual(["project-settings-changed"]);
  expect(JSON.stringify(warnings)).not.toContain("never expose this");
});

test("legacy snapshots do not invent configuration drift; gateway and image issues remain independent", async () => {
  const { project } = await addProject("https://github.com/org/example.git");
  const workspace = entry({ type: "project.git", projectId: project.id, name: project.name, gitUrl: project.gitUrl, branch: null, sessionShareKey: project.sessionShareKey });
  await createProjectEnvironmentVariable(project.id, { name: "REGION", value: "eu" });
  expect(await warningsFor(workspace)).toEqual([]);
  workspace.imageOutdated = true;
  workspace.issues = [{ kind: "gateway", message: "Gateway unavailable" }, { kind: "image", message: "Image inspection failed" }];
  expect((await warningsFor(workspace)).map((warning) => warning.kind)).toEqual(["gateway", "image"]);
});


test("only configured secrets contribute to setup drift", async () => {
  const { project } = await addProject("https://github.com/org/declarations.git");
  const workspace = entry(projectWorkspaceInit(project));
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const secret = await createProjectSecret(project.id, { ...values, optional: true });
  expect(await warningsFor(workspace)).toEqual([]);
  expect((await getProjectConfiguration(project.id)).configurationFingerprint).toBe(project.configurationFingerprint);
  await updateProjectSecret(project.id, secret.id, { ...values, optional: false, placeholder: "TOKEN_PLACEHOLDER", annotation: "Tests" });
  expect((await warningsFor(workspace)).map(({ kind }) => kind)).toEqual(["missing-secrets"]);
  await updateProjectSecret(project.id, secret.id, { ...values, secretValue: "configured-value" });
  expect((await warningsFor(workspace)).map(({ kind }) => kind)).toEqual(["project-settings-changed"]);
  const snapshot = await getProjectConfiguration(project.id);
  expect(snapshot.secrets[0]!.configured).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("configured-value");
  expect(JSON.stringify(snapshot)).not.toContain("encryptedSecret");
  await deleteProjectSecret(project.id, secret.id);
  expect(await warningsFor(workspace)).toEqual([]);
});

test("one project snapshot supplies consistent warnings to every workspace in a refresh", async () => {
  const { project } = await addProject("https://github.com/org/snapshot.git");
  const first = entry(projectWorkspaceInit(project));
  const second = { ...first, id: "second" };
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const secret = await createProjectSecret(project.id, values);
  const snapshot = await getProjectConfiguration(project.id);
  const before = workspaceWarnings(first, snapshot);
  await updateProjectSecret(project.id, secret.id, { ...values, secretValue: "real-value" });
  expect(workspaceWarnings(second, snapshot)).toEqual(before);
  expect(before.map(({ kind }) => kind)).toEqual(["missing-secrets"]);
  expect((await warningsFor(second)).map(({ kind }) => kind)).toEqual(["project-settings-changed"]);
});
