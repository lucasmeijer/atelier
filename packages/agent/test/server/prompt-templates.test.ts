import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { expandPromptTemplateText, loadPromptTemplatesFromRoot } from "../../src/server/prompt-templates.ts";

describe("prompt templates", () => {
  test("loads .atelier and .pi prompt templates", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-prompts-"));
    await mkdir(join(root, ".atelier/prompts"), { recursive: true });
    await mkdir(join(root, ".pi/prompts"), { recursive: true });
    await writeFile(join(root, ".atelier/prompts/land.md"), `---\ndescription: Land the workspace\nargument-hint: "[branch]"\n---\ncommit to ${"$"}{1:-main}`);
    await writeFile(join(root, ".pi/prompts/review.md"), "Review $ARGUMENTS");

    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.map((template) => template.trigger)).toEqual(["/land", "/review"]);
    expect(templates.find((template) => template.name === "land")?.argumentHint).toBe("[branch]");
  });

  test("includes builtin land template when repository does not provide one", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-prompts-"));

    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.map((template) => template.trigger)).toEqual(["/land"]);
    expect(templates[0]?.prompt).toBe("Commit and push your work, rebasing when necessary");
  });

  test("expands triggers with arguments", () => {
    const templates = [{ name: "land", trigger: "/land", description: "Land", argumentHint: "[branch]", prompt: 'push to ${1:-main}: $@' }];
    expect(expandPromptTemplateText("/land", templates)).toBe("push to main: ");
    expect(expandPromptTemplateText("/land release candidate", templates)).toBe("push to release: release candidate");
  });

  test("leaves normal prompts unchanged", () => {
    expect(expandPromptTemplateText("please run tests", [])).toBe("please run tests");
  });
});
