import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, listProjects, updateProject } from "@atelier/projects";
import { recordProjectWorkspaceCreation } from "../src/project.ts";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atelier-project-recency-"));
  file = join(directory, "projects.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("workspace creation persists recency without changing workspace configuration", async () => {
  const { project } = await addProject("https://github.com/org/repo.git", file);
  expect(project.lastWorkspaceCreatedAt).toBeUndefined();
  await recordProjectWorkspaceCreation(project.id, 1000, file);
  const stored = (await listProjects(file)).projects[0];
  expect(stored.lastWorkspaceCreatedAt).toBe(1000);
  expect(stored.configurationFingerprint).toBe(project.configurationFingerprint);
  await updateProject(project.id, { name: "Renamed", spec: project.gitUrl }, file);
  expect((await listProjects(file)).projects[0].lastWorkspaceCreatedAt).toBe(1000);
});

test("concurrent creations retain the latest timestamp and leave other projects untouched", async () => {
  const { project } = await addProject("https://github.com/org/used.git", file);
  const { project: unused } = await addProject("https://github.com/org/unused.git", file);
  await Promise.all([2000, 3000, 1000].map((at) => recordProjectWorkspaceCreation(project.id, at, file)));
  const { projects } = await listProjects(file);
  expect(projects.find((entry) => entry.id === project.id)?.lastWorkspaceCreatedAt).toBe(3000);
  expect(projects.find((entry) => entry.id === unused.id)?.lastWorkspaceCreatedAt).toBeUndefined();
});
