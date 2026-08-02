import { describe, expect, test } from "bun:test";
import { renderSlashCommandMenu } from "../../src/server/slash-commands.ts";

const skill = {
  name: "careful-review",
  description: "Review changes carefully",
};

describe("slash commands", () => {
  test("surfaces prompt templates and Pi-compatible skill commands together", () => {
    const html = renderSlashCommandMenu(
      [{ name: "review", trigger: "/review", description: "Review changes", prompt: "Review" }],
      [skill],
      "",
    );

    expect(html).toContain('aria-label="Slash commands"');
    expect(html).toContain("agent-completion-option agent-template-option active");
    expect(html).toContain('data-completion-kind="prompt-template"');
    expect(html).toContain('data-command-trigger="/review"');
    expect(html).toContain('data-completion-kind="skill"');
    expect(html).toContain('data-command-trigger="/skill:careful-review"');
    expect(html).toContain("Review changes carefully");
  });

  test("finds skills by their namespaced command and ranks prefix matches first", () => {
    const html = renderSlashCommandMenu([
      { name: "release-notes", trigger: "/release-notes", description: "Release notes", prompt: "Notes" },
      { name: "simplify", trigger: "/simplify", description: "Simplify", prompt: "Simplify" },
    ], [skill], "skill:care");

    expect(html).toContain("/skill:careful-review");
    expect(html).not.toContain("/release-notes");

    const ranked = renderSlashCommandMenu([
      { name: "release-notes", trigger: "/release-notes", description: "Release notes", prompt: "Notes" },
      { name: "simplify", trigger: "/simplify", description: "Simplify", prompt: "Simplify" },
    ], [], "s");
    expect(ranked.indexOf("/simplify")).toBeLessThan(ranked.indexOf("/release-notes"));
  });
});
