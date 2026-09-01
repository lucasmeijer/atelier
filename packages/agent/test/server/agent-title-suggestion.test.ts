import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceAgentConversationInfo } from "../../src/server/session-store.ts";
import { createAgentSessionTitleSetter } from "../../src/server/agent-title-suggestion.ts";

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

  test("renames a Workspace when its name matches the previous Agent title", async () => {
    const harness = titleHarness(false, "shared-name", true);

    await harness.setTitle(agent("shared-name"), "renamed-shared-name", { events: harness.events });

    expect(harness.conversation().title).toBe("renamed-shared-name");
    expect(harness.workspaceTitles).toEqual(["renamed-shared-name"]);
    expect(harness.emitted).toEqual(["agent:renamed-shared-name", "workspace:renamed-shared-name"]);
  });

  test("an automatic suggestion cannot overwrite an already named Agent session", async () => {
    const harness = titleHarness(true, "manual-name");

    const result = await harness.setTitle(agent("manual-name"), "late-ai-name", { events: harness.events, onlyIfUnnamed: true });

    expect(result.title).toBe("manual-name");
    expect(harness.workspaceTitles).toEqual([]);
    expect(harness.emitted).toEqual([]);
  });
});
