import { AtelierCoreError, createAtelierEventBus, type AtelierEventBus } from "@atelier/core";
import { type WorkspaceAgentTabProvider, type WorkspaceModule } from "@atelier/shared";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createWebApp, type WebApp } from "../src/server/app.ts";
import { workspaceModules } from "../src/server/workspace-modules.ts";
import { createWorkspaceRegistry, type WorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { workspaceWarnings } from "../src/server/workspace-warnings.ts";

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
  agent: TestAgentModule;
  workspaceId: string;
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
      conversations.splice(index, 1);
      closed.push(context);
    },
  };
  const module: WorkspaceModule = {
    id: "test-agent",
    agentProvider: {
      id: "builtin", label: "Builtin", iconHtml: "", tabs: provider,
      async create() {
        const conversation = creations.shift()!;
        conversations.push(conversation);
        return conversation.id;
      },
      launch: {
        async renderFooter() { return ""; }, async prepare() { return undefined; },
        async submit() { throw new Error("not used"); }, async prepareWorkspace() {},
      },
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
    const app = createWebApp({
      registry,
      events,
      provisionWorkspace: async () => {},
      deletionReview: { inspect: async () => ({ status: "clear" }), renderEvidence: () => "" },
      destroyWorkspace: async () => {},
      persistWorkspaceParked: async () => {},
      logError: () => {},
    });
    const workspaceId = "workspace-agent-routes";
    await registry.seed([{ id: workspaceId, title: "Agent routes" }]);
    await Bun.sleep(0);
    await run({ app, events, registry, agent, workspaceId });
  } finally {
    workspaceModules.splice(0, workspaceModules.length, ...originalModules);
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("Agent provider app integration", () => {
  test("automation retains command schemas and lists host agent commands once", async () => {
    const inputSchema = Type.Object({ value: Type.String() });
    await withTestApp([], async ({ app, workspaceId }) => {
      const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}`, { headers: { accept: "application/json" } }));
      const { workspace } = await response.json();
      expect(workspace.commands.find((command: { id: string }) => command.id === "test.command").inputSchema).toEqual(JSON.parse(JSON.stringify(inputSchema)));
      expect(workspace.commands.map((command: { id: string }) => command.id)).toEqual(["test.command", "agent.create", "agent.create.builtin"]);
    }, undefined, [{
      id: "test-command",
      commands: [{ id: "test.command", execute() { return {}; } }],
      attachToWorkspace() { return { commands: [{ id: "test.command", label: "Test command", scope: "workspace", inputSchema }] }; },
    }]);
  });

  test("warning dismissal does not attach modules or list Agent conversations", async () => {
    await withTestApp([{ id: "conversation-a", title: "Alpha" }], async ({ app, agent, registry, workspaceId }) => {
      registry.setIssue(workspaceId, "readiness", "Gateway unavailable");
      const warning = workspaceWarnings(registry.get(workspaceId)!, undefined)[0]!;
      const response = await app.fetch(new Request(`http://test.local/workspaces/${workspaceId}/warnings/readiness/dismiss`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ state: warning.state }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ dismissed: true });
      expect(agent.listedWorkspaceIds).toEqual([]);
    }, undefined, [{ id: "must-not-attach", attachToWorkspace() { throw new Error("Warning dismissal attached a module"); } }]);
  });

});

for (const operation of ["createWorkView", "presentWorkViewFromAgent"] as const) {
  test(`${operation} initializes Work views without a prior workspace read`, async () => {
    const types = ["default-view", "requested-view", "unopened-view"];
    const module: WorkspaceModule = {
      id: "test-work-views",
      workViews: types.map(type => ({
        type,
        parseReference: () => ({ type }),
        identity: () => "workspace",
        render: async () => "",
      })),
      attachToWorkspace: () => ({
        workViews: types.map(type => ({
          reference: { type }, sourceKey: `${type}:workspace`, label: type, kind: "resource" as const,
          availability: { phase: "live" as const }, initiallyOpen: type === "default-view",
        })),
      }),
    };
    await withTestApp([], async ({ app, workspaceId, agent }) => {
      await app[operation](workspaceId, { type: "requested-view" });
      await app[operation](workspaceId, { type: "requested-view" });
      const state = JSON.parse(await readFile(join(process.env.ATELIER_DATA_DIR!, "workspaces", workspaceId, "metadata", "presentation.json"), "utf8"));
      expect(state.workViews).toEqual([
        { reference: { type: "default-view" } },
        { reference: { type: "requested-view" } },
      ]);
      expect(agent.listedWorkspaceIds).toEqual([]);
      expect(agent.rendered).toEqual([]);
    }, undefined, [module]);
  });
}
