import { describe, expect, test } from "bun:test";
import { expandWorkspaceSkillCommand, workspaceSkillsFromFiles } from "../../src/server/skills.ts";

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
      body: "Full instructions",
    });
  });

  test("prefers Atelier skills over standard and Pi compatibility locations", async () => {
    const result = await workspaceSkillsFromFiles([
      { path: "/work/.pi/skills/review/SKILL.md", content: "---\ndescription: Pi review\n---\nPi" },
      { path: "/work/.agents/skills/review/SKILL.md", content: "---\ndescription: Standard review\n---\nStandard" },
      { path: "/work/.atelier/skills/review/SKILL.md", content: "---\ndescription: Atelier review\n---\nAtelier" },
    ]);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({ description: "Atelier review", body: "Atelier" });
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

describe("explicit workspace skill invocation", () => {
  const file = {
    path: "/work/.agents/skills/review/SKILL.md",
    content: "---\nname: review\ndescription: Review changes\ndisable-model-invocation: true\n---\nRead ./checklist.md and review carefully.",
  };
  const load = async (workspaceId: string) => {
    expect(workspaceId).toBe("selected-workspace");
    return workspaceSkillsFromFiles([file]);
  };

  const block = '<skill name="review" location="/work/.agents/skills/review/SKILL.md">\nReferences are relative to /work/.agents/skills/review.\n\nRead ./checklist.md and review carefully.\n</skill>';

  test("expands workspace content, including explicitly-only skills, without reading server paths", async () => {
    expect(await expandWorkspaceSkillCommand("selected-workspace", "/skill:review", load)).toBe(block);
  });

  test("accepts bare commands and all whitespace separators", async () => {
    for (const separator of [" ", "\n", "\t"]) {
      expect(await expandWorkspaceSkillCommand("selected-workspace", ` /skill:review${separator}First\nSecond `, load)).toBe(`${block}\n\nFirst\nSecond`);
    }
  });

  test("leaves ordinary messages untouched without discovering skills", async () => {
    const neverLoad = async (): Promise<never> => { throw new Error("unexpected discovery"); };
    for (const text of ["hello", "Use /skill:review please", "/land"]) {
      expect(await expandWorkspaceSkillCommand("selected-workspace", text, neverLoad)).toBe(text);
    }
  });

  test("rejects unknown commands and propagates workspace read failures", async () => {
    await expect(expandWorkspaceSkillCommand("selected-workspace", "/skill:missing", load)).rejects.toThrow("Unknown or invalid workspace skill: missing");
    await expect(expandWorkspaceSkillCommand("selected-workspace", "/skill:", load)).rejects.toThrow("missing name");
    const failedLoad = async (): Promise<never> => { throw new Error("workspace read failed"); };
    await expect(expandWorkspaceSkillCommand("selected-workspace", "/skill:review", failedLoad)).rejects.toThrow("workspace read failed");
  });

  test("resolves fresh content on every invocation", async () => {
    let content = file.content;
    const freshLoad = async () => workspaceSkillsFromFiles([{ ...file, content }]);
    expect(await expandWorkspaceSkillCommand("selected-workspace", "/skill:review", freshLoad)).toBe(block);
    content = content.replace("review carefully", "review updated instructions");
    expect(await expandWorkspaceSkillCommand("selected-workspace", "/skill:review", freshLoad)).toContain("review updated instructions");
  });
});
