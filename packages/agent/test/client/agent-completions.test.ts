import { describe, expect, mock, test } from "bun:test";
import { agentCompletionRequest, fileCompletionPrefix, focusAgentPrompt, forwardAgentTerminalWheel, insertSlashCommand, messageNavigationDirection, scrollMessageToTop, transcriptFollowingAfterScroll } from "../../src/client/agent-controllers.ts";

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
    const pane = { querySelector: () => ({ focus }) };

    expect(focusAgentPrompt(pane)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("agent transcript navigation", () => {
  test("scrolls the transcript to a message without scrolling outer containers", () => {
    const scrollTo = mock(() => {});
    const transcript = {
      scrollTop: 80,
      scrollHeight: 1_000,
      clientHeight: 300,
      scrollTo,
      getBoundingClientRect: () => ({ top: 100 }),
    };
    const message = { getBoundingClientRect: () => ({ top: 240 }) };

    scrollMessageToTop(transcript, message);

    expect(scrollTo).toHaveBeenCalledWith({ top: 220, behavior: "smooth" });
  });

  test("only considers the message reached while its beginning is aligned", () => {
    const transcript = {
      scrollTop: 100,
      scrollHeight: 1_000,
      clientHeight: 300,
      getBoundingClientRect: () => ({ top: 100 }),
    };
    const message = { getBoundingClientRect: () => ({ top: 340 - transcript.scrollTop }) };

    expect(messageNavigationDirection(transcript, message)).toBe("down");
    transcript.scrollTop = 240;
    expect(messageNavigationDirection(transcript, message)).toBeUndefined();
    transcript.scrollTop = 400;
    expect(messageNavigationDirection(transcript, message)).toBe("up");
  });

  test("preserves following when a delayed scroll event observes newly streamed content", () => {
    expect(transcriptFollowingAfterScroll(true, 400, 400, 580)).toBe(true);
  });

  test("stops following when the user scrolls away from the previous end", () => {
    expect(transcriptFollowingAfterScroll(true, 400, 300, 580)).toBe(false);
  });

  test("resumes following when the user returns within the end threshold", () => {
    expect(transcriptFollowingAfterScroll(false, 580, 525, 580)).toBe(true);
    expect(transcriptFollowingAfterScroll(false, 580, 519, 580)).toBe(false);
  });

  test("forwards live terminal wheel input to the agent transcript", () => {
    const transcript = { scrollTop: 120, clientHeight: 500 };
    const terminal = { closest: () => transcript };
    const preventDefault = mock(() => {});
    const stopPropagation = mock(() => {});
    const event = { deltaY: 3, deltaMode: 1, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2, ctrlKey: false, preventDefault, stopPropagation };

    expect(forwardAgentTerminalWheel(terminal, event)).toBe(true);
    expect(transcript.scrollTop).toBe(168);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("agent prompt completion activation", () => {
  test("slash resources and @ references are the only automatic completions", () => {
    expect(agentCompletionRequest(input("/review"))).toEqual({ kind: "slash-command", query: "review" });
    expect(agentCompletionRequest(input("/skill:review"))).toEqual({ kind: "slash-command", query: "skill:review" });
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
    expect(agentCompletionRequest(input("/tmp"))).toEqual({ kind: "slash-command", query: "tmp" });
    expect(agentCompletionRequest(input("/tmp"), true)).toEqual({ kind: "file", query: "/tmp", mode: "direct" });
    expect(agentCompletionRequest(input("/tmp/bla"))).toBeUndefined();
    expect(agentCompletionRequest(input("/tmp/bla"), true)).toEqual({ kind: "file", query: "/tmp/bla", mode: "direct" });
  });

  test("a selected prompt template replaces a partial trigger before inline expansion", () => {
    const textarea = input("/rev");
    const option = { dataset: { commandTrigger: "/review" } };

    insertSlashCommand(option, textarea);
    expect(textarea.value).toBe("/review ");
    expect(textarea.selectionStart).toBe(8);
  });

  test("a selected skill inserts Pi's namespaced command", () => {
    const textarea = input("/skill:rev");
    const option = { dataset: { commandTrigger: "/skill:review" } };

    insertSlashCommand(option, textarea);
    expect(textarea.value).toBe("/skill:review ");
    expect(textarea.selectionStart).toBe(14);
  });

  test("file token extraction supports quoted and in-sentence paths", () => {
    expect(fileCompletionPrefix(input('open @"path with sp'))).toBe('@"path with sp');
    expect(fileCompletionPrefix(input("open /tmp/bla"))).toBe("/tmp/bla");
  });
});
