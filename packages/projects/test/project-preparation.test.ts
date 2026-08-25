import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectPreparationPrompt, stageProjectPreparationPrompt } from "@atelier/projects";
import type { WorkspaceCreationContext } from "@atelier/workspace";

describe("project preparation", () => {
  test("stages an editable preparation prompt when .atelier is absent", async () => {
    const work = await mkdtemp(join(tmpdir(), "atelier-project-preparation-"));
    const context: WorkspaceCreationContext = { agent: { initialPrompt: "Fix the dashboard", model: "provider::model" } };
    try {
      expect(stageProjectPreparationPrompt(work, context)).toBe(true);
      expect(context.agent).toMatchObject({ initialPromptMode: "draft", model: "provider::model" });
      expect(context.agent?.initialPrompt).toContain("Prepare this project for efficient use in Atelier");
      expect(context.agent?.initialPrompt).toContain("Fix the dashboard");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("honors a preparation choice already made in the quick composer", async () => {
    const work = await mkdtemp(join(tmpdir(), "atelier-project-preparation-"));
    const context: WorkspaceCreationContext = { agent: { initialPrompt: "Prepare it" }, projectPreparation: "accepted" };
    try {
      expect(stageProjectPreparationPrompt(work, context)).toBe(false);
      expect(context.agent?.initialPrompt).toBe("Prepare it");
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("leaves the requested task unchanged when .atelier exists", async () => {
    const work = await mkdtemp(join(tmpdir(), "atelier-project-preparation-"));
    const context: WorkspaceCreationContext = { agent: { initialPrompt: "Fix the dashboard" } };
    try {
      await mkdir(join(work, ".atelier"));
      expect(stageProjectPreparationPrompt(work, context)).toBe(false);
      expect(context.agent).toEqual({ initialPrompt: "Fix the dashboard" });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test("preparation prompt does not invent an original request", () => {
    expect(projectPreparationPrompt()).not.toContain("original request:");
  });
});
