import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, getProjectConfiguration, listProjects, setProjectPreloadImages, updateProject } from "../src/project.ts";

test("preload settings preserve old projects, normalize references and do not invalidate existing workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "project-preload-"));
  try {
    const file = join(dir, "projects.json");
    const { project } = await addProject("/tmp/example", file);
    expect(project.preloadImages).toEqual([]);
    const fingerprint = project.configurationFingerprint;
    const images = ["atelier:default-workspace", "registry.example:5000/team/image:tag@sha256:" + "a".repeat(64)];
    const updated = await setProjectPreloadImages(project.id, [` ${images[0]} `, images[1]!, images[0]!], file);
    expect(updated.project.preloadImages).toEqual(images);
    expect(updated.project.configurationFingerprint).toBe(fingerprint);
    await updateProject(project.id, { name: "Renamed", spec: "/tmp/example" }, file);
    expect((await getProjectConfiguration(project.id, file)).preloadImages).toEqual(images);
    for (const invalid of ["", "https://registry/image", "postgres:17 other", "--help", "image\nnext"]) {
      await expect(setProjectPreloadImages(project.id, [invalid], file)).rejects.toThrow("Invalid image reference");
    }
    expect((await listProjects(file)).projects[0]!.preloadImages).toEqual(images);
    await setProjectPreloadImages(project.id, [], file);
    expect((await getProjectConfiguration(project.id, file)).preloadImages).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
