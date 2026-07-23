import { describe, expect, mock, test } from "bun:test";
import { agentCompletionRequest, fileCompletionPrefix, focusAgentPrompt, forwardAgentTerminalWheel, hasScrolledToMessage, insertPromptTemplate, scrollMessageToTop } from "../../src/client/agent-controllers.ts";

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

describe("agent transcript navigation", () => {
  test("scrolls the transcript to a message without scrolling outer containers", () => {
    const scrollTo = mock(() => {});
    const transcript = {
      scrollTop: 80,
      scrollTo,
      getBoundingClientRect: () => ({ top: 100 }),
    } as unknown as HTMLElement;
    const message = { getBoundingClientRect: () => ({ top: 240 }) } as unknown as HTMLElement;

    scrollMessageToTop(transcript, message);

    expect(scrollTo).toHaveBeenCalledWith({ top: 220, behavior: "smooth" });
  });

  test("detects whether the transcript has reached a message", () => {
    const transcript = {
      scrollTop: 100,
      scrollHeight: 1_000,
      clientHeight: 300,
      getBoundingClientRect: () => ({ top: 100 }),
    } as unknown as HTMLElement;
    const message = { getBoundingClientRect: () => ({ top: 340 - transcript.scrollTop }) } as unknown as HTMLElement;

    expect(hasScrolledToMessage(transcript, message)).toBe(false);
    transcript.scrollTop = 240;
    expect(hasScrolledToMessage(transcript, message)).toBe(true);
  });

  test("forwards live terminal wheel input to the agent transcript", () => {
    const transcript = { scrollTop: 120, clientHeight: 500 } as HTMLElement;
    const terminal = { closest: () => transcript } as unknown as HTMLElement;
    const preventDefault = mock(() => {});
    const stopPropagation = mock(() => {});
    const event = { deltaY: 3, deltaMode: 1, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2, ctrlKey: false, preventDefault, stopPropagation } as unknown as WheelEvent;

    expect(forwardAgentTerminalWheel(terminal, event)).toBe(true);
    expect(transcript.scrollTop).toBe(168);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
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
