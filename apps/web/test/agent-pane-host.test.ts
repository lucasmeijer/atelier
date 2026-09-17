import { expect, test } from "bun:test";
import type { WorkspaceAgentProvider, WorkspaceAgentTabSummary } from "@atelier/shared";
import { createAgentPaneHost } from "../src/server/agent-pane-host.ts";

function occupant(id: string, initial: WorkspaceAgentTabSummary[]) {
  let conversations = initial;
  const closed: string[] = [];
  const provider: WorkspaceAgentProvider = {
    id, label: id, iconHtml: id,
    tabs: {
      list: async () => conversations,
      render: async ({ conversationId }) => `${id}/${conversationId}`,
      close: async ({ conversationId }) => {
        closed.push(conversationId);
        conversations = conversations.filter((conversation) => conversation.id !== conversationId);
      },
    },
    async create() { throw new Error("Listing must not create an agent"); },
    launch: {
      async renderFooter() { return ""; }, async prepare() { return undefined; },
      async submit() { throw new Error("not used"); }, async prepareWorkspace() { throw new Error("Listing must not prepare a workspace"); }, async refreshConfiguration() { return ""; },
    },
  };
  return { provider, closed };
}

test("empty panes stay empty without preparing a default", async () => {
  const host = createAgentPaneHost([occupant("builtin", []).provider, occupant("codex", []).provider]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
});

test("mixed providers expose ownership and route rendering and closure", async () => {
  const builtin = occupant("builtin", [{ id: "first", title: "First" }]);
  const codex = occupant("codex", [{ id: "second", title: "Second" }, { id: "third", title: "Third" }]);
  const host = createAgentPaneHost([builtin.provider, codex.provider]);
  expect((await host.list({ workspaceId: "workspace" })).map(({ id, providerId }) => ({ id, providerId }))).toEqual([
    { id: "first", providerId: "builtin" }, { id: "second", providerId: "codex" }, { id: "third", providerId: "codex" },
  ]);
  expect(await host.render({ workspaceId: "workspace", conversationId: "second" })).toBe("codex/second");
  await host.close({ workspaceId: "workspace", conversationId: "second" });
  expect(codex.closed).toEqual(["second"]);
  expect(builtin.closed).toEqual([]);
});

test("concurrent closures may close the last tab and retain the empty state", async () => {
  const { provider, closed } = occupant("builtin", [{ id: "first", title: "First" }, { id: "second", title: "Second" }]);
  const host = createAgentPaneHost([provider]);
  await Promise.all([host.close({ workspaceId: "workspace", conversationId: "first" }), host.close({ workspaceId: "workspace", conversationId: "second" })]);
  expect(closed).toEqual(["first", "second"]);
  expect(await host.list({ workspaceId: "workspace" })).toEqual([]);
});

test("unknown identities do not reach a provider", async () => {
  const { provider, closed } = occupant("builtin", [{ id: "existing", title: "Existing" }]);
  const host = createAgentPaneHost([provider]);
  await expect(host.close({ workspaceId: "workspace", conversationId: "missing" })).rejects.toMatchObject({ code: "agent_conversation_not_found" });
  expect(closed).toEqual([]);
});

test("ambiguous provider and conversation identities fail explicitly", async () => {
  const a = occupant("a", [{ id: "same", title: "A" }]).provider;
  const b = occupant("b", [{ id: "same", title: "B" }]).provider;
  expect(() => createAgentPaneHost([a, a])).toThrow("Duplicate agent provider identity");
  await expect(createAgentPaneHost([a, b]).list({ workspaceId: "workspace" })).rejects.toThrow("Duplicate agent conversation identity");
});
