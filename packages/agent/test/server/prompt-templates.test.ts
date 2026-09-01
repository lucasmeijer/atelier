import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { expandPromptTemplateText, loadPromptTemplatesFromRoot, parseCompactCommand, parseAgentSessionNameCommand } from "../../src/server/prompt-templates.ts";

describe("prompt templates", () => {
  test("loads .atelier and .pi prompt templates", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-prompts-"));
    await mkdir(join(root, ".atelier/prompts"), { recursive: true });
    await mkdir(join(root, ".pi/prompts"), { recursive: true });
    await writeFile(join(root, ".atelier/prompts/land.md"), `---\ndescription: Land the workspace\nargument-hint: "[branch]"\nquick-launch: true\n---\ncommit to ${"$"}{1:-main}`);
    await writeFile(join(root, ".pi/prompts/review.md"), "Review $ARGUMENTS");

    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.map((template) => template.trigger)).toEqual(["/compact", "/land", "/name", "/new", "/park", "/review"]);
    expect(templates.find((template) => template.name === "land")).toMatchObject({ argumentHint: "[branch]", quickLaunch: true });
    const nameCommand = templates.find((template) => template.name === "name");
    expect(nameCommand).toMatchObject({
      trigger: "/name",
      argumentHint: "[session-name]",
      prompt: "/name",
    });
    expect(expandPromptTemplateText("/name my-custom-name", templates)).toBe("/name my-custom-name");
  });

  test("includes builtin land template when repository does not provide one", async () => {
    const root = await mkdtemp(join(tmpdir(), "atelier-prompts-"));

    const templates = await loadPromptTemplatesFromRoot(root);
    expect(templates.map((template) => template.trigger)).toEqual(["/compact", "/land", "/name", "/new", "/park"]);
    expect(templates[0]).toMatchObject({ trigger: "/compact", argumentHint: "[instructions]", prompt: "/compact", preserveArguments: true });
    expect(templates[1]?.prompt).toBe("Commit and push your work, rebasing when necessary. When successful, delete this workspace.");
    expect(templates[2]).toMatchObject({ trigger: "/name", description: "Rename this Agent session, using AI when no name is provided.", prompt: "/name" });
    expect(templates[3]).toMatchObject({ trigger: "/new", description: "Start a new Agent conversation.", prompt: "/new" });
    expect(templates[4]).toMatchObject({ trigger: "/park", description: "Park this workspace.", prompt: "/park" });
  });

  test("expands triggers with arguments", () => {
    const templates = [{ name: "land", trigger: "/land", description: "Land", argumentHint: "[branch]", prompt: 'push to ${1:-main}: $@' }];
    expect(expandPromptTemplateText("/land", templates)).toBe("push to main: ");
    expect(expandPromptTemplateText("/land release candidate", templates)).toBe("push to release: release candidate");
  });

  test("parses compaction commands with optional custom instructions", () => {
    expect(parseCompactCommand("/compact")).toEqual({});
    expect(parseCompactCommand(" /compact   Preserve exact test commands. ")).toEqual({ customInstructions: "Preserve exact test commands." });
    expect(parseCompactCommand("/compactness")).toBeUndefined();
  });

  test("parses AI and manual Agent session name commands", () => {
    expect(parseAgentSessionNameCommand("/name")).toEqual({});
    expect(parseAgentSessionNameCommand(" /name   my-custom-name ")).toEqual({ title: "my-custom-name" });
    expect(parseAgentSessionNameCommand("/names")).toBeUndefined();
  });

  test("leaves normal prompts unchanged", () => {
    expect(expandPromptTemplateText("please run tests", [])).toBe("please run tests");
  });
});
