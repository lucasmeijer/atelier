import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WorkspaceAgentConversationInfo } from "../../src/server/session-store.ts";
import { agentTitleRequestOptions, createAutomaticWorkspaceNamingGate, createAgentSessionTitleSetter } from "../../src/server/agent-title-suggestion.ts";

const agent = (title = "Untitled"): WorkspaceAgentConversationInfo => ({
  workspaceId: "workspace-1",
  conversationId: "53fc77b7-dc19-42d5-b200-2e134ec67529",
  label: "Agent 1",
  title,
  path: "/tmp/agent.jsonl",
});

function titleHarness(workspaceUnnamed: boolean, initialTitle = "Untitled", workspaceFollowsAgentTitle = workspaceUnnamed) {
  let conversation = agent(initialTitle);
  const workspaceTitles: string[] = [];
  const events = createAtelierEventBus();
  const emitted: string[] = [];
  events.on("workspace_agent_conversation_title_changed", ({ title }) => { emitted.push(`agent:${title}`); });
  events.on("workspace_title_changed", ({ title }) => { emitted.push(`workspace:${title}`); });
  const setTitle = createAgentSessionTitleSetter({
    listConversations: async () => [conversation],
    setConversationTitle: async (current, title) => (conversation = { ...current, title }),
    workspaceShouldFollowAgentTitle: async () => workspaceFollowsAgentTitle,
    setWorkspaceTitle: async (_workspaceId, title) => { workspaceTitles.push(title); },
  });
  return { setTitle, events, conversation: () => conversation, workspaceTitles, emitted };
}

describe("Agent session titles", () => {
  test("names an unnamed Workspace after the Agent session", async () => {
    const harness = titleHarness(true);

    await harness.setTitle(agent(), "selected-agent-tabs", { events: harness.events });

    expect(harness.conversation().title).toBe("selected-agent-tabs");
    expect(harness.workspaceTitles).toEqual(["selected-agent-tabs"]);
    expect(harness.emitted).toEqual(["agent:selected-agent-tabs", "workspace:selected-agent-tabs"]);
  });

  test("does not replace an existing Workspace name", async () => {
    const harness = titleHarness(false);

    await harness.setTitle(agent(), "session-specific-name", { events: harness.events });

    expect(harness.conversation().title).toBe("session-specific-name");
    expect(harness.workspaceTitles).toEqual([]);
    expect(harness.emitted).toEqual(["agent:session-specific-name"]);
  });

  test("automatically names an unnamed tab in an already named workspace", async () => {
    const harness = titleHarness(false);

    await harness.setTitle(agent(), "first-prompt-name", { events: harness.events, onlyIfUnnamed: true });

    expect(harness.conversation().title).toBe("first-prompt-name");
    expect(harness.workspaceTitles).toEqual([]);
    expect(harness.emitted).toEqual(["agent:first-prompt-name"]);
  });

  test("automatic naming preserves a manual title applied while the model responds", async () => {
    const harness = titleHarness(false);
    const original = harness.conversation();
    await harness.setTitle(original, "my-name", { events: harness.events });

    await harness.setTitle(original, "ai-name", { events: harness.events, onlyIfUnnamed: true });

    expect(harness.conversation().title).toBe("my-name");
    expect(harness.emitted).toEqual(["agent:my-name"]);
  });

  test("renames a Workspace when its name matches the previous Agent title", async () => {
    const harness = titleHarness(false, "shared-name", true);

    await harness.setTitle(agent("shared-name"), "renamed-shared-name", { events: harness.events });

    expect(harness.conversation().title).toBe("renamed-shared-name");
    expect(harness.workspaceTitles).toEqual(["renamed-shared-name"]);
    expect(harness.emitted).toEqual(["agent:renamed-shared-name", "workspace:renamed-shared-name"]);
  });

});

describe("title request options", () => {
  test("leave Anthropic's cheapest model enough answer room without a thinking budget", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const model = runtime.getModels("anthropic").toSorted((a, b) => a.cost.input - b.cost.input)[0]!;
    let request: { max_tokens: number; thinking?: { type: string; budget_tokens?: number } } | undefined;
    const captureRequest: typeof fetch = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return new Response("{}", { status: 400 });
    }, { preconnect: fetch.preconnect });

    await runtime.completeSimple(model, { messages: [{ role: "user", content: "Name this session", timestamp: Date.now() }] }, {
      ...agentTitleRequestOptions, apiKey: "test-key", fetch: captureRequest,
    });

    // Anthropic rejects a thinking budget below 1024 tokens, which silently blocked every name.
    expect(request!.thinking?.budget_tokens).toBeUndefined();
    expect(request!.max_tokens).toBeGreaterThanOrEqual(16);
  });
});

describe("automatic workspace naming", () => {
  test("launch and message submissions share one in-flight request and successful result", async () => {
    const name = createAutomaticWorkspaceNamingGate();
    const result = Promise.withResolvers<boolean>();
    let requests = 0;
    const launch = name("workspace-1", async () => { requests++; return await result.promise; });
    await name("workspace-1", async () => { requests++; return true; });
    expect(requests).toBe(1);
    result.resolve(true);
    await launch;
    await name("workspace-1", async () => { requests++; return true; });
    expect(requests).toBe(1);
  });

  test("failed or insufficient-context suggestions allow a later prompt to retry", async () => {
    const name = createAutomaticWorkspaceNamingGate();
    let requests = 0;
    await name("workspace-1", async () => { requests++; return false; });
    await name("workspace-1", async () => { requests++; return true; });
    expect(requests).toBe(2);
  });

  test("a thrown request releases the in-flight gate", async () => {
    const name = createAutomaticWorkspaceNamingGate();
    await expect(name("workspace-1", async () => { throw new Error("provider failed"); })).rejects.toThrow("provider failed");
    let retried = false;
    await name("workspace-1", async () => { retried = true; return true; });
    expect(retried).toBe(true);
  });

  test("different workspaces can generate titles concurrently", async () => {
    const name = createAutomaticWorkspaceNamingGate();
    const result = Promise.withResolvers<boolean>();
    const first = name("workspace-1", () => result.promise);
    let secondNamed = false;
    await name("workspace-2", async () => { secondNamed = true; return true; });
    expect(secondNamed).toBe(true);
    result.resolve(true);
    await first;
  });
});
