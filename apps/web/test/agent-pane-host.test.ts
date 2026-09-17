import { expect, test } from "bun:test";
import type { WorkspaceAgentTabProvider, WorkspaceAgentTabSummary } from "@atelier/shared";
import { createAgentPaneHost } from "../src/server/agent-pane-host.ts";

function occupants(initial: WorkspaceAgentTabSummary[]) {
  let conversations = initial;
  const closed: string[] = [];
  const tabs: WorkspaceAgentTabProvider = {
    list: async () => conversations,
    render: async ({ conversationId }) => conversationId,
    close: async ({ conversationId }) => {
      closed.push(conversationId);
      conversations = conversations.filter((conversation) => conversation.id !== conversationId);
    },
  };
  return { tabs, closed, add: (conversation: WorkspaceAgentTabSummary) => { conversations.push(conversation); } };
}

test("an occupied pane does not prepare the default agent", async () => {
  const { tabs } = occupants([{ id: "existing", title: "Existing" }]);
  let preparations = 0;
  const host = createAgentPaneHost(tabs, async () => { preparations++; });
  expect(await host.list({ workspaceId: "workspace" })).toEqual([{ id: "existing", title: "Existing" }]);
  expect(preparations).toBe(0);
});

test("concurrent discovery prepares the default only once for an empty pane", async () => {
  const { tabs, add } = occupants([]);
  let preparations = 0;
  const host = createAgentPaneHost(tabs, async () => {
    preparations++;
    add({ id: "default", title: "Default" });
  });
  const lists = await Promise.all([host.list({ workspaceId: "workspace" }), host.list({ workspaceId: "workspace" })]);
  expect(preparations).toBe(1);
  expect(lists[0]).toEqual(lists[1]);
  expect(lists[0]).toHaveLength(1);
});

test("the host serializes closures and preserves one tab without imposing occupant-specific lifecycle", async () => {
  const { tabs, closed } = occupants([{ id: "first", title: "First" }, { id: "second", title: "Second" }]);
  const host = createAgentPaneHost(tabs, async () => { throw new Error("Unexpected preparation"); });
  const results = await Promise.allSettled([
    host.close({ workspaceId: "workspace", conversationId: "first" }),
    host.close({ workspaceId: "workspace", conversationId: "second" }),
  ]);
  expect(results[0]).toMatchObject({ status: "fulfilled" });
  expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "last_agent_conversation" } });
  expect(closed).toEqual(["first"]);
});

test("unknown identities do not reach the occupant's close operation", async () => {
  const { tabs, closed } = occupants([{ id: "existing", title: "Existing" }]);
  const host = createAgentPaneHost(tabs, async () => {});
  await expect(host.close({ workspaceId: "workspace", conversationId: "missing" })).rejects.toMatchObject({ code: "agent_conversation_not_found" });
  expect(closed).toEqual([]);
});
