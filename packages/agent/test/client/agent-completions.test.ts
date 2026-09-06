import { describe, expect, mock, test } from "bun:test";
import { type AgentCompletionInput, agentCompletionRequest, agentComposerPrimaryAction, agentComposerTextStorageKey, agentConnectionShouldRun, fileCompletionPrefix, forwardAgentTerminalWheel, insertSlashCommand, navigatePromptHistory, promptTemplateHotkeyConflict, terminalOutputHasPrintableText } from "../../src/client/agent-controllers.ts";

function input(value: string, cursor = value.length): AgentCompletionInput {
  return {
    value,
    selectionStart: cursor,
    selectionEnd: cursor,
    setSelectionRange(start, end) {
      this.selectionStart = start ?? 0;
      this.selectionEnd = end ?? 0;
    },
  };
}

describe("Agent pane residency", () => {
  test("runs live connections only while logically visible in a visible document", () => {
    expect(agentConnectionShouldRun(true, "visible")).toBe(true);
    expect(agentConnectionShouldRun(false, "visible")).toBe(false);
    expect(agentConnectionShouldRun(true, "hidden")).toBe(false);
  });

  test("keys durable composer text by immutable conversation identity", () => {
    expect(agentComposerTextStorageKey("workspace-1", "conversation-1")).toBe('atelier.agentComposerText:["workspace-1","conversation-1"]');
    expect(agentComposerTextStorageKey("workspace-1", "conversation-2")).not.toBe(agentComposerTextStorageKey("workspace-1", "conversation-1"));
    expect(agentComposerTextStorageKey("workspace-2", "conversation-1")).not.toBe(agentComposerTextStorageKey("workspace-1", "conversation-1"));
  });

  test("uses attachments as message content when choosing the busy primary action", () => {
    expect(agentComposerPrimaryAction(true, "", 0)).toBe("abort");
    expect(agentComposerPrimaryAction(true, "", 1)).toBe("steer");
    expect(agentComposerPrimaryAction(true, "Follow up", 0)).toBe("steer");
    expect(agentComposerPrimaryAction(false, "", 0)).toBe("send");
  });
});

describe("agent terminal output", () => {
  test("does not treat terminal initialization escapes as visible output", () => {
    const initialization = "\x1b[?1049h\x1b[H\x1b[2J\x1b=\x1b(B\x1b[m\r\n";
    expect(terminalOutputHasPrintableText(initialization)).toBe(false);
    expect(terminalOutputHasPrintableText(`${initialization}ready\r\n`)).toBe(true);
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

describe("agent prompt history", () => {
  test("cycles backward through prompts and forward to the original draft", () => {
    const prompts = ["first", "second", "third"];
    const latest = navigatePromptHistory(undefined, "up", "unfinished draft", prompts)!;
    expect(latest.value).toBe("third");

    const previous = navigatePromptHistory(latest.state, "up", latest.value, prompts)!;
    expect(previous.value).toBe("second");
    const oldest = navigatePromptHistory(previous.state, "up", previous.value, prompts)!;
    expect(navigatePromptHistory(oldest.state, "up", oldest.value, prompts)!.value).toBe("first");

    const next = navigatePromptHistory(oldest.state, "down", oldest.value, prompts)!;
    expect(next.value).toBe("second");
    const newest = navigatePromptHistory(next.state, "down", next.value, prompts)!;
    expect(newest.value).toBe("third");
    expect(navigatePromptHistory(newest.state, "down", newest.value, prompts)).toEqual({ state: undefined, value: "unfinished draft" });
  });

  test("does not start by navigating down or without previous prompts", () => {
    expect(navigatePromptHistory(undefined, "down", "draft", ["first"])).toBeUndefined();
    expect(navigatePromptHistory(undefined, "up", "draft", [])).toBeUndefined();
  });
});

describe("agent prompt completion activation", () => {
  test("quick launches appear only before the user types", () => {
    expect(agentCompletionRequest(input(""))).toEqual({ kind: "quick-launch", query: "" });
    expect(agentCompletionRequest(input(" "))).toBeUndefined();
    expect(agentCompletionRequest(input("draft"))).toBeUndefined();
  });

  test("slash resources and @ references are the only typed automatic completions", () => {
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

  test("rejects prompt-template hotkeys already assigned to Atelier commands", () => {
    const commands = [
      { label: "Open VS Code", binding: "Meta+Alt+KeyV" },
      { label: "New Terminal", binding: "Meta+Alt+KeyT" },
    ];

    expect(promptTemplateHotkeyConflict("v", commands)?.label).toBe("Open VS Code");
    expect(promptTemplateHotkeyConflict("s", commands)).toBeUndefined();
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
