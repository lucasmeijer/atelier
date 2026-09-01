import { describe, expect, test } from "bun:test";
import { renderSlashCommandCatalog } from "../../src/server/slash-commands.ts";

const skill = {
  name: "careful-review",
  description: "Review changes carefully",
};

describe("slash commands", () => {
  test("renders the complete catalog of application commands, templates, and skills", () => {
    const templates = Array.from({ length: 15 }, (_, index) => ({
      name: `prompt-${index}`,
      trigger: `/prompt-${index}`,
      description: `Prompt ${index}`,
      prompt: `Do ${index}`,
      quickLaunch: index === 2,
    }));

    const html = renderSlashCommandCatalog(templates, [skill]);

    expect((html.match(/data-command-trigger=/g) ?? []).length).toBe(18);
    expect(html).toContain('data-command-trigger="/tree" data-command-action="tree"');
    expect(html).toContain('data-completion-kind="prompt-template"');
    expect(html).toContain('data-command-trigger="/prompt-14"');
    expect(html).toContain('data-completion-kind="skill"');
    expect(html).toContain('data-command-trigger="/skill:careful-review"');
    expect(html).toContain("Review changes carefully");
    expect(html).toContain('role="group" aria-label="Quick launch"');
    expect(html).toContain('data-completion-kind="quick-launch" data-command-trigger="/prompt-2">/prompt-2</button>');
    expect(html.match(/data-completion-kind="quick-launch"/g)).toHaveLength(1);
  });
});
