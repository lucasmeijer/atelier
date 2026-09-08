import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, listProjects, setProjectDockerfile, updateProject } from "../src/project.ts";

test("project Dockerfile persists, survives repository edits, validates and clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-dockerfile-"));
  try {
    const file = join(dir, "projects.json");
    const { project } = await addProject("/tmp/example", file);
    expect(project.dockerfile).toBeUndefined();
    const dockerfile = "FROM atelier-workspace\nRUN echo custom\n";
    await setProjectDockerfile(project.id, dockerfile, file);
    await updateProject(project.id, { name: "Renamed", spec: "/tmp/example" }, file);
    expect((await listProjects(file)).projects[0]!.dockerfile).toBe(dockerfile);
    await expect(setProjectDockerfile(project.id, "FROM ubuntu", file)).rejects.toThrow("FROM atelier-workspace");
    expect((await listProjects(file)).projects[0]!.dockerfile).toBe(dockerfile);
    await setProjectDockerfile(project.id, " \n", file);
    expect((await listProjects(file)).projects[0]!.dockerfile).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
