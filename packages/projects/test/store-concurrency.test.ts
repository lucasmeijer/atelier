import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, createProjectEnvironmentVariable, createProjectSecret, listProjectEnvironmentVariables, listProjects, revealProjectSecrets, updateProject, updateProjectSecret } from "@atelier/projects";

let directory: string;
let file: string;
let keyFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atelier-project-transactions-"));
  file = join(directory, "projects.json");
  keyFile = join(directory, "project-secrets.key");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("concurrent project additions preserve every project", async () => {
  const added = await Promise.all(["one", "two", "three"].map((name) => addProject(`https://github.com/org/${name}.git`, file)));
  const stored = await listProjects(file);
  expect(stored.projects.map((project) => project.id).sort()).toEqual(added.map(({ project }) => project.id).sort());
});

test("project, environment, and encrypted secret mutations share one transaction", async () => {
  const { project } = await addProject("https://github.com/org/repo.git", file);
  await Promise.all([
    updateProject(project.id, { name: "Renamed", spec: project.gitUrl }, file),
    createProjectEnvironmentVariable(project.id, { name: "API_URL", value: "https://example.com" }, file),
    createProjectSecret(project.id, { envName: "TOKEN_ONE", hostPattern: "example.com", secretValue: "one" }, file, keyFile),
    createProjectSecret(project.id, { envName: "TOKEN_TWO", hostPattern: "example.com", secretValue: "two" }, file, keyFile),
  ]);
  expect((await listProjects(file)).projects[0].name).toBe("Renamed");
  expect(await listProjectEnvironmentVariables(project.id, file)).toMatchObject([{ name: "API_URL", value: "https://example.com" }]);
  expect((await revealProjectSecrets(project.id, file, keyFile)).map((secret) => secret.secretValue).sort()).toEqual(["one", "two"]);
});

test("failed async mutations are not persisted and release the transaction", async () => {
  const { project } = await addProject("https://github.com/org/repo.git", file);
  const secret = await createProjectSecret(project.id, { envName: "TOKEN", hostPattern: "example.com", secretValue: "original" }, file, keyFile);
  const invalidKeyFile = join(directory, "invalid.key");
  await writeFile(invalidKeyFile, "invalid");

  await expect(updateProjectSecret(project.id, secret.id, { envName: "CHANGED", hostPattern: "changed.example.com", secretValue: "changed" }, file, invalidKeyFile)).rejects.toThrow("project secrets key must be 32 bytes");
  await createProjectEnvironmentVariable(project.id, { name: "AFTER_FAILURE", value: "saved" }, file);

  expect(await revealProjectSecrets(project.id, file, keyFile)).toMatchObject([{ envName: "TOKEN", hostPattern: "example.com", secretValue: "original" }]);
  expect(await listProjectEnvironmentVariables(project.id, file)).toMatchObject([{ name: "AFTER_FAILURE", value: "saved" }]);
});
