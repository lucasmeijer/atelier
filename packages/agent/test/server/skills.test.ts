import { describe, expect, test } from "bun:test";
import { workspaceSkillsFromFiles } from "../../src/server/skills.ts";

describe("workspace skills", () => {
  test("loads Agent Skills metadata for Pi's progressive-disclosure prompt", async () => {
    const result = await workspaceSkillsFromFiles([{
      path: "/work/.agents/skills/review/SKILL.md",
      content: "---\nname: careful-review\ndescription: Review changes carefully\ndisable-model-invocation: true\n---\nFull instructions",
    }]);

    expect(result.diagnostics).toEqual([]);
    expect(result.skills[0]).toMatchObject({
      name: "careful-review",
      description: "Review changes carefully",
      filePath: "/work/.agents/skills/review/SKILL.md",
      baseDir: "/work/.agents/skills/review",
      disableModelInvocation: true,
    });
  });

  test("prefers Atelier skills over standard and Pi compatibility locations", async () => {
    const result = await workspaceSkillsFromFiles([
      { path: "/work/.pi/skills/review/SKILL.md", content: "---\ndescription: Pi review\n---\nPi" },
      { path: "/work/.agents/skills/review/SKILL.md", content: "---\ndescription: Standard review\n---\nStandard" },
      { path: "/work/.atelier/skills/review/SKILL.md", content: "---\ndescription: Atelier review\n---\nAtelier" },
    ]);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe("Atelier review");
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((diagnostic) => diagnostic.type === "collision")).toBe(true);
  });

  test("rejects skills without the description required by the Agent Skills specification", async () => {
    const result = await workspaceSkillsFromFiles([{
      path: "/work/.atelier/skills/review/SKILL.md",
      content: "# Review\nNo frontmatter",
    }]);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([{
      type: "warning",
      message: "description is required",
      path: "/work/.atelier/skills/review/SKILL.md",
    }]);
  });
});
