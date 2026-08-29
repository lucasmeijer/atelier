import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AtelierCoreError, createAtelierEventBus, type AtelierEventBus, type JsonObject } from "@atelier/core";
import { atelierCableConnectionHeader, type CableIdentifier, type WorkspaceAgentTabProvider, type WorkspaceModule, type WorkspaceModuleWorkViewAdapter, type WorkspaceWorkViewReference } from "@atelier/shared";
import { createWebApp, type WebApp } from "../src/server/app.ts";
import type { CableBroadcastOptions } from "../src/server/cable.ts";
import {
  agentActionsDomId,
  agentBodiesDomId,
  agentBodyFrameId,
  agentNavigationDomId,
  agentPaneSlotDomId,
  agentTabDomId,
  workViewSelectorDomId,
} from "../src/server/workspace-presentation.ts";
import { createWorkspaceRegistry, type WorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { workspaceModules } from "../src/server/workspace-modules.ts";

interface TestConversation {
  id: string;
  title: string;
}

interface TestAgentModule {
  module: WorkspaceModule;
  conversations: TestConversation[];
  listedWorkspaceIds: string[];
  rendered: Array<{ workspaceId: string; conversationId: string }>;
  closed: Array<{ workspaceId: string; conversationId: string }>;
}

interface TestAppContext {
  app: WebApp;
  events: AtelierEventBus;
  registry: WorkspaceRegistry;
  broadcasts: Array<{ identifier: CableIdentifier; html: string; options?: CableBroadcastOptions }>;
  agent: TestAgentModule;
  workspaceId: string;
}

const testWorkViewReferenceSchema = Type.Object({ type: Type.Literal("test-work"), id: Type.String() });
type TestWorkViewReference = Static<typeof testWorkViewReferenceSchema> & WorkspaceWorkViewReference;

function createTestWorkModule(referenceOrReferences: TestWorkViewReference | TestWorkViewReference[]): WorkspaceModule {
  const references = Array.isArray(referenceOrReferences) ? referenceOrReferences : [referenceOrReferences];
  const adapter: WorkspaceModuleWorkViewAdapter<TestWorkViewReference> = {
    type: "test-work",
    parseReference(value) {
      return Value.Parse(testWorkViewReferenceSchema, value);
    },
    identity(candidate) {
      return candidate.id;
    },
    render() {
      return "<p>Test Work view</p>";
    },
  };
  return {
    id: "test-work",
    workViews: [adapter],
    attachToWorkspace() {
      return {
        workViews: references.map((reference) => ({
          reference,
          sourceKey: reference.id,
          label: `Test Work ${reference.id}`,
          kind: "resource",
          availability: { phase: "live" },
        })),
      };
    },
  };
}

function createTestAgentModule(initial: TestConversation[], created: TestConversation | TestConversation[] = { id: "conversation-new", title: "New Agent" }): TestAgentModule {
  const conversations = initial.map((conversation) => ({ ...conversation }));
  const creations = (Array.isArray(created) ? created : [created]).map((conversation) => ({ ...conversation }));
  const listedWorkspaceIds: string[] = [];
  const rendered: Array<{ workspaceId: string; conversationId: string }> = [];
  const closed: Array<{ workspaceId: string; conversationId: string }> = [];
  const provider: WorkspaceAgentTabProvider = {
    async list({ workspaceId }) {
      listedWorkspaceIds.push(workspaceId);
      return conversations.map(({ id, title }) => ({ id, title }));
    },
    async render(context) {
      const conversation = conversations.find((candidate) => candidate.id === context.conversationId);
      if (!conversation) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${context.conversationId}`);
      rendered.push(context);
      return `<article data-rendered-conversation="${conversation.id}">${conversation.title} body</article>`;
    },
    async close(context) {
      const index = conversations.findIndex((candidate) => candidate.id === context.conversationId);
      if (index < 0) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${context.conversationId}`);
      if (conversations.length === 1) throw new AtelierCoreError("last_agent_conversation", "The last Agent conversation cannot be closed");
      conversations.splice(index, 1);
      closed.push(context);
    },
  };
  const module: WorkspaceModule = {
    id: "test-agent",
    agentTabs: provider,
    commands: [{
      id: "agent.create",
      execute() {
        const conversation = creations.shift();
        if (!conversation) throw new Error("No test Agent conversation remains to create");
        conversations.push(conversation);
        return { createdAgentConversationId: conversation.id };
      },
    }],
    attachToWorkspace() {
      return {
        commands: [{
          id: "agent.create",
          label: "New Agent",
          scope: "workspace",
          surfaces: { ui: { placement: "agent-action" } },
        }],
      };
    },
  };
  return { module, conversations, listedWorkspaceIds, rendered, closed };
}

async function withTestApp(
  initial: TestConversation[],
  run: (context: TestAppContext) => Promise<void>,
  created?: TestConversation | TestConversation[],
  additionalModules: WorkspaceModule[] = [],
): Promise<void> {
  const previousDataDir = process.env.ATELIER_DATA_DIR;
  const dataDir = await mkdtemp(join(tmpdir(), "atelier-app-agent-routes-"));
  const originalModules = workspaceModules.splice(0, workspaceModules.length);
  const agent = createTestAgentModule(initial, created);
  process.env.ATELIER_DATA_DIR = dataDir;
  workspaceModules.push(agent.module, ...additionalModules);
  try {
    const registry = createWorkspaceRegistry();
    const events = createAtelierEventBus();
    const broadcasts: Array<{ identifier: CableIdentifier; html: string; options?: CableBroadcastOptions }> = [];
    const app = createWebApp({
      registry,
      events,
      cable: { broadcast: (identifier, html, options) => broadcasts.push({ identifier, html, options }) },
      provisionWorkspace: async () => {},
      provisioningHooks: [],
      inspectDeleteSafety: async (workspaceId) => ({ workspaceId, issues: [] }),
      destroyWorkspace: async () => {},
      persistWorkspaceParked: async () => {},
      logError: () => {},
    });
    const workspaceId = "workspace-agent-routes";
    await registry.seed([{ id: workspaceId, title: "Agent routes" }]);
    await Bun.sleep(0);
    broadcasts.length = 0;
    await run({ app, events, registry, broadcasts, agent, workspaceId });
  } finally {
    workspaceModules.splice(0, workspaceModules.length, ...originalModules);
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

function turboPost(path: string, connectionId?: string): Request {
  const headers = new Headers({ accept: "text/vnd.turbo-stream.html" });
  if (connectionId) headers.set(atelierCableConnectionHeader, connectionId);
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers,
  });
}

function turboJsonPost(path: string, body: JsonObject, connectionId?: string): Request {
  const headers = new Headers({ accept: "text/vnd.turbo-stream.html", "content-type": "application/json" });
  if (connectionId) headers.set(atelierCableConnectionHeader, connectionId);
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function jsonPost(path: string): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "application/json" },
  });
}

describe("Agent provider app integration", () => {
  test("Workspace metadata stays cheap and the body route renders exactly one immutable conversation", async () => {
    await withTestApp([
      { id: "conversation-a", title: "Alpha" },
      { id: "conversation-b", title: "Beta" },
    ], async ({ app, agent, workspaceId }) => {
      const resident = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}?resident=1`));
      const residentHtml = await resident.text();
      expect(resident.status).toBe(200);
      expect(residentHtml).toContain(`src="/workspaces/${workspaceId}/agents/conversation-a/body"`);
      expect(residentHtml).toContain(`src="/workspaces/${workspaceId}/agents/conversation-b/body"`);
      expect(residentHtml).not.toContain("data-rendered-conversation");
      expect(agent.rendered).toEqual([]);

      const body = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/agents/conversation-b/body`));
      const bodyHtml = await body.text();
      expect(body.status).toBe(200);
      expect(body.headers.get("content-type")).toContain("text/html");
      expect(body.headers.get("cache-control")).toBe("no-store");
      expect(bodyHtml).toContain(`<turbo-frame id="${agentBodyFrameId(workspaceId, "conversation-b")}">`);
      expect(bodyHtml).toContain('data-rendered-conversation="conversation-b"');
      expect(agent.rendered).toEqual([{ workspaceId, conversationId: "conversation-b" }]);

      const displayLabel = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/agents/Beta/body`, { headers: { accept: "application/json" } }));
      expect(displayLabel.status).toBe(404);
      expect(await displayLabel.json()).toMatchObject({ error: { code: "agent_conversation_not_found" } });
    });
  });

  test("Agent view invalidation preserves conversation scope and excludes only its origin connection", async () => {
    await withTestApp([
      { id: "conversation-a", title: "Alpha" },
      { id: "conversation-b", title: "Beta" },
    ], async ({ events, broadcasts, agent, workspaceId }) => {
      const targeted = '<turbo-stream action="remove" target="agent-suggestion"></turbo-stream>';
      await events.emit("workspace_agent_view_invalidated", { workspaceId, conversationId: "conversation-b", exceptConnectionId: "origin-connection", html: targeted });

      expect(agent.rendered).toEqual([]);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]!.identifier).toEqual({ channel: "shell" });
      expect(broadcasts[0]!.options).toEqual({ exceptConnectionId: "origin-connection" });
      expect(broadcasts[0]!.html).toStartWith(targeted);
      expect(broadcasts[0]!.html).toContain('action="invalidate-workspace-preparation"');
      expect(broadcasts[0]!.html).toContain(`data-workspace-id="${workspaceId}"`);
      expect(broadcasts[0]!.html).toContain('data-conversation-id="conversation-b"');
    });
  });

  test("creating an Agent broadcasts structure before targeting selection on the origin Cable connection", async () => {
    await withTestApp(
      [{ id: "conversation-a", title: "Alpha" }],
      async ({ app, broadcasts, agent, workspaceId }) => {
        const response = await app.fetch(turboPost(`/workspaces/${workspaceId}/commands/agent.create`, "origin-connection"));
        const html = await response.text();

        expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
        expect(html).toBe("");
        expect(agent.rendered).toEqual([]);

        const mutationBroadcasts = broadcasts.filter(({ html }) => html.includes(`target="${agentBodiesDomId(workspaceId)}"`) || html.includes('action="select-agent"'));
        expect(mutationBroadcasts).toHaveLength(2);
        const structural = mutationBroadcasts[0]!;
        expect(structural.identifier).toEqual({ channel: "shell" });
        expect(structural.options).toBeUndefined();
        expect(structural.html).toContain(`<turbo-stream action="update" target="${agentNavigationDomId(workspaceId)}"`);
        expect(structural.html).toContain(`<turbo-stream action="update" target="${agentActionsDomId(workspaceId)}"`);
        expect(structural.html).toContain(`<turbo-stream action="append" target="${agentBodiesDomId(workspaceId)}"`);
        expect(structural.html).toContain(`src="/workspaces/${workspaceId}/agents/conversation-b/body"`);
        expect(structural.html).toContain('action="invalidate-workspace-preparation"');
        expect(structural.html).not.toContain('action="select-agent"');
        expect(structural.html).not.toContain('<turbo-stream action="replace"');
        expect(structural.html).not.toContain("data-rendered-conversation");

        const selection = mutationBroadcasts[1]!;
        expect(selection.identifier).toEqual({ channel: "shell" });
        expect(selection.options).toEqual({ onlyConnectionId: "origin-connection" });
        expect(selection.html).toContain('action="select-agent"');
        expect(selection.html).toContain('data-conversation-id="conversation-b"');
        expect(selection.html).not.toContain(`target="${agentBodiesDomId(workspaceId)}"`);
      },
      { id: "conversation-b", title: "Beta" },
    );
  });

  test("without a Cable identity, concurrent Agent creation returns complete monotonic fallback streams", async () => {
    await withTestApp(
      [{ id: "conversation-a", title: "Alpha" }],
      async ({ app, broadcasts, workspaceId }) => {
        const [firstResponse, secondResponse] = await Promise.all([
          app.fetch(turboPost(`/workspaces/${workspaceId}/commands/agent.create`)),
          app.fetch(turboPost(`/workspaces/${workspaceId}/commands/agent.create`)),
        ]);
        const [firstHtml, secondHtml] = await Promise.all([firstResponse.text(), secondResponse.text()]);

        expect(firstHtml).toContain(`id="${agentTabDomId(workspaceId, "conversation-b")}"`);
        expect(firstHtml).not.toContain(`id="${agentTabDomId(workspaceId, "conversation-c")}"`);
        expect(firstHtml).toContain('action="select-agent"');
        expect(firstHtml).toContain('data-conversation-id="conversation-b"');
        expect(secondHtml).toContain(`id="${agentTabDomId(workspaceId, "conversation-b")}"`);
        expect(secondHtml).toContain(`id="${agentTabDomId(workspaceId, "conversation-c")}"`);
        expect(secondHtml).toContain('action="select-agent"');
        expect(secondHtml).toContain('data-conversation-id="conversation-c"');

        const structural = broadcasts.filter((broadcast) => broadcast.html.includes(`target="${agentBodiesDomId(workspaceId)}"`));
        expect(structural).toHaveLength(2);
        expect(structural[0]!.html).toContain("conversation-b/body");
        expect(structural[0]!.html).not.toContain("conversation-c/body");
        expect(structural[1]!.html).toContain("conversation-c/body");
        expect(structural[1]!.html).toContain(`id="${agentTabDomId(workspaceId, "conversation-b")}"`);
        expect(structural[1]!.html).toContain(`id="${agentTabDomId(workspaceId, "conversation-c")}"`);
      },
      [
        { id: "conversation-b", title: "Beta" },
        { id: "conversation-c", title: "Gamma" },
      ],
    );
  });

  test("delayed Agent command responses cannot regress newer Cable navigation", async () => {
    await withTestApp(
      [{ id: "conversation-a", title: "Alpha" }],
      async ({ app, broadcasts, workspaceId }) => {
        const [firstResponse, secondResponse] = await Promise.all([
          app.fetch(turboPost(`/workspaces/${workspaceId}/commands/agent.create`, "first-origin")),
          app.fetch(turboPost(`/workspaces/${workspaceId}/commands/agent.create`, "second-origin")),
        ]);

        const secondHtml = await secondResponse.text();
        const firstHtml = await firstResponse.text();
        expect(secondHtml).toBe("");
        expect(firstHtml).toBe("");

        const mutationBroadcasts = broadcasts.filter(({ html }) => html.includes(`target="${agentBodiesDomId(workspaceId)}"`) || html.includes('action="select-agent"'));
        expect(mutationBroadcasts).toHaveLength(4);
        expect(mutationBroadcasts.map(({ options }) => options)).toEqual([
          undefined,
          { onlyConnectionId: "first-origin" },
          undefined,
          { onlyConnectionId: "second-origin" },
        ]);
        expect(mutationBroadcasts[0]!.html).toContain(`id="${agentTabDomId(workspaceId, "conversation-b")}"`);
        expect(mutationBroadcasts[0]!.html).not.toContain(`id="${agentTabDomId(workspaceId, "conversation-c")}"`);
        expect(mutationBroadcasts[1]!.html).toContain('data-conversation-id="conversation-b"');
        expect(mutationBroadcasts[2]!.html).toContain(`id="${agentTabDomId(workspaceId, "conversation-b")}"`);
        expect(mutationBroadcasts[2]!.html).toContain(`id="${agentTabDomId(workspaceId, "conversation-c")}"`);
        expect(mutationBroadcasts[3]!.html).toContain('data-conversation-id="conversation-c"');
      },
      [
        { id: "conversation-b", title: "Beta" },
        { id: "conversation-c", title: "Gamma" },
      ],
    );
  });

  test("closing an Agent removes only its pane, chooses its ordered successor, and broadcasts the same structure", async () => {
    await withTestApp([
      { id: "conversation-a", title: "Alpha" },
      { id: "conversation-b", title: "Beta" },
      { id: "conversation-c", title: "Gamma" },
    ], async ({ app, registry, broadcasts, agent, workspaceId }) => {
      registry.markViewUnread(workspaceId, "agent:conversation-b");
      broadcasts.length = 0;
      const response = await app.fetch(turboPost(`/workspaces/${workspaceId}/agents/conversation-b/close`));
      const html = await response.text();

      expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
      expect(agent.closed).toEqual([{ workspaceId, conversationId: "conversation-b" }]);
      expect(agent.conversations.map(({ id }) => id)).toEqual(["conversation-a", "conversation-c"]);
      expect(registry.isViewUnread(workspaceId, "agent:conversation-b")).toBe(false);
      expect(html).toContain(`<turbo-stream action="update" target="${agentNavigationDomId(workspaceId)}"`);
      expect(html).not.toContain(`id="${agentTabDomId(workspaceId, "conversation-b")}"`);
      expect(html).toContain(`<turbo-stream action="update" target="${agentActionsDomId(workspaceId)}"`);
      expect(html).toContain(`<turbo-stream action="remove" target="${agentPaneSlotDomId(workspaceId, "conversation-b")}"`);
      expect(html).toContain('action="select-agent-successor"');
      expect(html).toContain('data-closed-conversation-id="conversation-b"');
      expect(html).toContain('data-successor-conversation-id="conversation-c"');
      expect(html).toContain('action="invalidate-workspace-preparation"');
      expect(html).not.toContain('<turbo-stream action="replace"');
      expect(html).not.toContain("data-rendered-conversation");

      const structural = broadcasts.find((broadcast) => broadcast.html.includes(`target="${agentPaneSlotDomId(workspaceId, "conversation-b")}"`));
      expect(structural?.identifier).toEqual({ channel: "shell" });
      expect(structural?.html).toBe(html);

      registry.markViewUnread(workspaceId, "agent:conversation-c");
      broadcasts.length = 0;
      const jsonResponse = await app.fetch(jsonPost(`/workspaces/${workspaceId}/agents/conversation-c/close`));
      expect(await jsonResponse.json()).toEqual({
        archivedConversationId: "conversation-c",
        agentConversations: [{ id: "conversation-a", title: "Alpha" }],
      });
      expect(registry.isViewUnread(workspaceId, "agent:conversation-c")).toBe(false);
      expect(broadcasts.some((broadcast) => broadcast.html.includes(`target="${agentPaneSlotDomId(workspaceId, "conversation-c")}"`))).toBe(true);

      const lastAgent = await app.fetch(jsonPost(`/workspaces/${workspaceId}/agents/conversation-a/close`));
      expect(lastAgent.status).toBe(409);
      expect(await lastAgent.json()).toMatchObject({ error: { code: "last_agent_conversation" } });
      expect(agent.conversations).toEqual([{ id: "conversation-a", title: "Alpha" }]);
      const lastAgentTurbo = await app.fetch(turboPost(`/workspaces/${workspaceId}/agents/conversation-a/close`));
      expect(lastAgentTurbo.status).toBe(409);

      const closeMissingWorkspace = await app.fetch(jsonPost("/workspaces/missing/agents/conversation-a/close"));
      expect(closeMissingWorkspace.status).toBe(404);
      expect(agent.closed).toHaveLength(2);
    });
  });

  test("Agent attention acknowledgement compare-and-clears only the exact completion occurrence", async () => {
    await withTestApp([
      { id: "conversation-a", title: "Alpha" },
      { id: "conversation-b", title: "Beta" },
    ], async ({ app, registry, broadcasts, agent, workspaceId }) => {
      registry.markViewUnread(workspaceId, "agent:conversation-a");
      const staleToken = registry.markViewUnread(workspaceId, "agent:conversation-b")!;
      const currentToken = registry.markViewUnread(workspaceId, "agent:conversation-b")!;
      broadcasts.length = 0;
      const stale = await app.fetch(turboPost(`/workspaces/${workspaceId}/agents/conversation-b/attention/acknowledge?attentionToken=${staleToken}`));
      expect(stale.status).toBe(204);
      expect(registry.isViewUnread(workspaceId, "agent:conversation-b")).toBe(true);

      const response = await app.fetch(turboPost(`/workspaces/${workspaceId}/agents/conversation-b/attention/acknowledge?attentionToken=${currentToken}`));

      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(registry.isViewUnread(workspaceId, "agent:conversation-a")).toBe(true);
      expect(registry.isViewUnread(workspaceId, "agent:conversation-b")).toBe(false);
      expect(agent.rendered).toEqual([]);
      expect(agent.closed).toEqual([]);
      expect(broadcasts.some((broadcast) => broadcast.html.includes(`target="${agentNavigationDomId(workspaceId)}"`))).toBe(false);

      const missing = await app.fetch(jsonPost(`/workspaces/${workspaceId}/agents/conversation-missing/attention/acknowledge?attentionToken=${currentToken}`));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "agent_conversation_not_found" } });
    });
  });

  test("Workspace attention acknowledgement compare-and-clears only the exact Workspace occurrence", async () => {
    await withTestApp([{ id: "conversation-a", title: "Alpha" }], async ({ app, registry, workspaceId }) => {
      registry.markViewUnread(workspaceId, "agent:conversation-a");
      registry.markViewUnread(workspaceId, "test-work:review");
      const staleToken = registry.markViewUnread(workspaceId, "workspace")!;
      const currentToken = registry.markViewUnread(workspaceId, "workspace")!;

      const stale = await app.fetch(turboPost(`/workspaces/${workspaceId}/attention/acknowledge?attentionToken=${staleToken}`));
      expect(stale.status).toBe(204);
      expect(registry.isViewUnread(workspaceId, "workspace")).toBe(true);

      const response = await app.fetch(turboPost(`/workspaces/${workspaceId}/attention/acknowledge?attentionToken=${currentToken}`));
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe("");
      expect(registry.isViewUnread(workspaceId, "workspace")).toBe(false);
      expect(registry.isViewUnread(workspaceId, "agent:conversation-a")).toBe(true);
      expect(registry.isViewUnread(workspaceId, "test-work:review")).toBe(true);

      const missingToken = await app.fetch(turboPost(`/workspaces/${workspaceId}/attention/acknowledge`));
      expect(missingToken.status).toBe(400);
      const missingWorkspace = await app.fetch(jsonPost(`/workspaces/missing/attention/acknowledge?attentionToken=${currentToken}`));
      expect(missingWorkspace.status).toBe(404);
    });
  });

  test("Work attention persists and clears unread state for the exact Work-view key", async () => {
    const reference: TestWorkViewReference = { type: "test-work", id: "review" };
    await withTestApp(
      [{ id: "conversation-a", title: "Alpha" }],
      async ({ app, registry, workspaceId }) => {
        const key = "test-work:review";
        const otherKey = "test-work:other";
        const resident = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}?resident=1`));
        expect(resident.status).toBe(200);

        registry.markViewUnread(workspaceId, otherKey);
        await app.presentWorkViewFromAgent(workspaceId, reference);
        expect(registry.isViewUnread(workspaceId, key)).toBe(true);
        const staleToken = registry.viewUnreadToken(workspaceId, key)!;

        const requested = await app.fetch(turboPost(`/workspaces/${workspaceId}/work-views/${encodeURIComponent(key)}/attention/request`));
        expect(requested.status).toBe(200);
        const currentToken = registry.viewUnreadToken(workspaceId, key)!;
        expect(currentToken).toBeGreaterThan(staleToken);

        const stale = await app.fetch(turboPost(`/workspaces/${workspaceId}/work-views/${encodeURIComponent(key)}/attention/acknowledge?attentionToken=${staleToken}`));
        expect(stale.status).toBe(204);
        expect(registry.isViewUnread(workspaceId, key)).toBe(true);

        const acknowledged = await app.fetch(turboPost(`/workspaces/${workspaceId}/work-views/${encodeURIComponent(key)}/attention/acknowledge?attentionToken=${currentToken}`));
        expect(acknowledged.status).toBe(204);
        expect(registry.isViewUnread(workspaceId, key)).toBe(false);
        expect(registry.isViewUnread(workspaceId, otherKey)).toBe(true);

        const rerequested = await app.fetch(turboPost(`/workspaces/${workspaceId}/work-views/${encodeURIComponent(key)}/attention/request`));
        expect(rerequested.status).toBe(200);
        expect(registry.isViewUnread(workspaceId, key)).toBe(true);

        const encodedReference = encodeURIComponent(JSON.stringify(reference));
        const closed = await app.fetch(turboPost(`/workspaces/${workspaceId}/work-views/${encodedReference}/close`));
        expect(closed.status).toBe(200);
        expect(registry.isViewUnread(workspaceId, key)).toBe(false);
        expect(registry.isViewUnread(workspaceId, otherKey)).toBe(true);
      },
      undefined,
      [createTestWorkModule(reference)],
    );
  });

  test("delayed Work reorder responses cannot overwrite the newest selector order", async () => {
    const firstReference: TestWorkViewReference = { type: "test-work", id: "first" };
    const secondReference: TestWorkViewReference = { type: "test-work", id: "second" };
    await withTestApp(
      [{ id: "conversation-a", title: "Alpha" }],
      async ({ app, broadcasts, workspaceId }) => {
        const resident = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}?resident=1`));
        expect(resident.status).toBe(200);
        broadcasts.length = 0;

        const firstResponse = await app.fetch(turboJsonPost(
          `/workspaces/${workspaceId}/work-views/reorder`,
          { key: "test-work:first", index: 1 },
          "first-origin",
        ));
        const secondResponse = await app.fetch(turboJsonPost(
          `/workspaces/${workspaceId}/work-views/reorder`,
          { key: "test-work:first", index: 0 },
          "second-origin",
        ));

        expect(await secondResponse.text()).toBe("");
        expect(await firstResponse.text()).toBe("");
        expect(broadcasts).toHaveLength(2);
        expect(broadcasts.map(({ options }) => options)).toEqual([undefined, undefined]);

        const firstSelectorId = `id="${workViewSelectorDomId(workspaceId, "test-work:first")}"`;
        const secondSelectorId = `id="${workViewSelectorDomId(workspaceId, "test-work:second")}"`;
        expect(broadcasts[0]!.html.indexOf(secondSelectorId)).toBeLessThan(broadcasts[0]!.html.indexOf(firstSelectorId));
        expect(broadcasts[1]!.html.indexOf(firstSelectorId)).toBeLessThan(broadcasts[1]!.html.indexOf(secondSelectorId));
      },
      undefined,
      [createTestWorkModule([firstReference, secondReference])],
    );
  });
});
