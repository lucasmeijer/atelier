import { describe, expect, test } from "bun:test";
import { expandPromptTemplate } from "../../src/server/prompt-templates.ts";

describe("prompt templates", () => {
  test("expands /land into the landing prompt", () => {
    expect(expandPromptTemplate("/land")).toBe("commit and push your work to origin/main.  when succesful, use the delete_current_workspace toolcall to discard this session and the associated atelier execution environment");
  });

  test("matches template triggers after trimming whitespace", () => {
    expect(expandPromptTemplate("  /land\n")).toBe(expandPromptTemplate("/land"));
  });

  test("leaves normal prompts unchanged", () => {
    expect(expandPromptTemplate("please run tests")).toBe("please run tests");
  });
});
