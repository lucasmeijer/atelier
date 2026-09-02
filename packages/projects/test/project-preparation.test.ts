import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addProject, neverOfferProjectPreparation, projectPreparationPrompt, stageProjectPreparationPrompt } from "@atelier/projects";
import type { WorkspaceCreationContext } from "@atelier/workspace";

async function withProject(run: (project: { id: string; work: string; store: string }) => Promise<void>): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "atelier-project-preparation-"));
  const store = join(work, "projects.json");
  try {
    const { id } = (await addProject("https://github.com/org/project.git", store)).project;
    await run({ id, work, store });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

describe("project preparation", () => {
  test("stages an editable preparation prompt when .atelier is absent", async () => {
    await withProject(async ({ id, work, store }) => {
      const context: WorkspaceCreationContext = { agent: { initialPrompt: "Fix the dashboard", model: "provider::model" } };
      expect(await stageProjectPreparationPrompt(id, work, context, store)).toBe(true);
      expect(context.agent).toMatchObject({ initialPromptMode: "suggestion", model: "provider::model" });
      expect(context.agent?.initialPrompt).toContain("Prepare this project for efficient use in Atelier");
      expect(context.agent?.initialPrompt).toContain("Fix the dashboard");
    });
  });

  test("leaves the requested task unchanged when .atelier exists", async () => {
    await withProject(async ({ id, work, store }) => {
      const context: WorkspaceCreationContext = { agent: { initialPrompt: "Fix the dashboard" } };
      await mkdir(join(work, ".atelier"));
      expect(await stageProjectPreparationPrompt(id, work, context, store)).toBe(false);
      expect(context.agent).toEqual({ initialPrompt: "Fix the dashboard" });
    });
  });

  test("honors the server-persisted never-ask choice", async () => {
    await withProject(async ({ id, work, store }) => {
      const context: WorkspaceCreationContext = { agent: { initialPrompt: "Fix the dashboard" } };
      await neverOfferProjectPreparation(id, store);
      expect(await stageProjectPreparationPrompt(id, work, context, store)).toBe(false);
      expect(context.agent).toEqual({ initialPrompt: "Fix the dashboard" });
    });
  });

  test("preparation prompt does not invent an original request", () => {
    expect(projectPreparationPrompt()).not.toContain("original request:");
  });
});
