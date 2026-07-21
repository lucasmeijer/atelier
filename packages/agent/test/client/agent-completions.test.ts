import { describe, expect, mock, test } from "bun:test";
import { agentCompletionRequest, fileCompletionPrefix, focusAgentPrompt, insertPromptTemplate } from "../../src/client/agent-controllers.ts";

function input(value: string, cursor = value.length): HTMLTextAreaElement {
  return {
    value,
    selectionStart: cursor,
    selectionEnd: cursor,
    setSelectionRange(start, end) {
      this.selectionStart = start ?? 0;
      this.selectionEnd = end ?? 0;
    },
  } as HTMLTextAreaElement;
}

describe("agent prompt focus", () => {
  test("focuses without scrolling the tab", () => {
    const focus = mock(() => {});
    const pane = { querySelector: () => ({ focus }) } as unknown as HTMLElement;

    expect(focusAgentPrompt(pane)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("agent prompt completion activation", () => {
  test("slash resources and @ references are the only automatic completions", () => {
    expect(agentCompletionRequest(input("/review"))).toEqual({ kind: "prompt-template", query: "review" });
    expect(agentCompletionRequest(input("look at @packages/agent"))).toEqual({ kind: "file", query: "packages/agent", mode: "fuzzy" });
    expect(agentCompletionRequest(input("look at packages/agent/src/"))).toBeUndefined();
    expect(agentCompletionRequest(input("look at ./packages"))).toBeUndefined();
    expect(agentCompletionRequest(input("look at ~/notes/"))).toBeUndefined();
  });

  test("Tab explicitly completes an ordinary word or path", () => {
    expect(agentCompletionRequest(input("look at packages/agent/src/"), true)).toEqual({ kind: "file", query: "packages/agent/src/", mode: "direct" });
    expect(agentCompletionRequest(input("look at rend"), true)).toEqual({ kind: "file", query: "rend", mode: "direct" });
  });

  test("a leading absolute path can fall through from slash resources to Tab completion", () => {
    expect(agentCompletionRequest(input("/tmp"))).toEqual({ kind: "prompt-template", query: "tmp" });
    expect(agentCompletionRequest(input("/tmp"), true)).toEqual({ kind: "file", query: "/tmp", mode: "direct" });
    expect(agentCompletionRequest(input("/tmp/bla"))).toBeUndefined();
    expect(agentCompletionRequest(input("/tmp/bla"), true)).toEqual({ kind: "file", query: "/tmp/bla", mode: "direct" });
  });

  test("a selected prompt template replaces a partial trigger before inline expansion", () => {
    const textarea = input("/rev");
    const option = { dataset: { templateTrigger: "/review" } } as unknown as HTMLElement;

    insertPromptTemplate(option, textarea);
    expect(textarea.value).toBe("/review ");
    expect(textarea.selectionStart).toBe(8);
  });

  test("file token extraction supports quoted and in-sentence paths", () => {
    expect(fileCompletionPrefix(input('open @"path with sp'))).toBe('@"path with sp');
    expect(fileCompletionPrefix(input("open /tmp/bla"))).toBe("/tmp/bla");
  });
});
