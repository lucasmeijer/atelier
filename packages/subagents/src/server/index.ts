import { preserveLegacySubagentHistories } from "./history-store.ts";
import { Icons } from "@atelier/design-system/icons";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { WorkspaceModule } from "@atelier/shared";
import { listWorkspaceAgentConversations } from "@atelier/agent/server";
export { subagentsDelegation } from "./delegation.ts";
import { getSubagents } from "./subagents.ts";
import { subagentsWorkView, subagentsWorkViewAdapter, handleSubagentRequest, subscribeSubagentTree } from "./subagent-view.ts";
import { subagentsOpenApiPaths } from "./openapi.ts";

export const atelierServerModule: WorkspaceModule = {
  id: "subagents",
  initialize: () => preserveLegacySubagentHistories(),
  staticFiles: { "/subagents.css": { url: new URL("../client/subagents.css", import.meta.url), contentType: "text/css; charset=utf-8" } },
  workViews: [subagentsWorkViewAdapter],
  openApiPaths: subagentsOpenApiPaths,
  commands: [{ id: "subagents.open", execute: () => ({ createdWorkView: { type: "subagents" } }) }],
  cableChannels: [{
    name: "subagents",
    subscribe(identifier, listener, events) {
      if (identifier.channel !== "module" || identifier.name !== "subagents") throw new Error("Invalid Subagents channel");
      const params = Value.Parse(Type.Object({ conversationId: Type.String({ minLength: 1 }) }, { additionalProperties: false }), identifier.params);
      return subscribeSubagentTree(identifier.workspaceId, params.conversationId, listener, events);
    },
  }],
  attachToWorkspace() {
    return { workViews: [subagentsWorkView], commands: [{ id: "subagents.open", label: "Subagents", scope: "workspace", surfaces: { ui: { placement: "work-launcher", iconHtml: Icons.Subagents, label: "Subagents" } } }] };
  },
  routes: [{
    async handle(request, url, context) {
      const reveal = url.pathname.match(/^\/workspaces\/([^/]+)\/subagents\/reveal$/);
      if (reveal && (request.method === "POST" || request.method === "GET")) {
        const workspaceId = decodeURIComponent(reveal[1]!);
        const form = request.method === "GET" ? url.searchParams : await request.formData();
        const coordinator = await getSubagents(workspaceId, context.events);
        const target = String(form.get("child"));
        const child = coordinator.state.agents.find((agent) => agent.id === target);
        const message = coordinator.state.messages.find((message) => message.id === String(form.get("message")));
        if (!message || (message.from !== target && message.to !== target)) return new Response("Subagent message not found", { status: 404 });
        if (!child) {
          const roots = await listWorkspaceAgentConversations(workspaceId);
          if (!roots.some((root) => root.conversationId === target)) return new Response("Agent not found", { status: 404 });
          const query = new URLSearchParams({ agent: target, agentTarget: message.id });
          return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${query}` } });
        }
        await context.openWorkView(workspaceId, { type: "subagents" });
        const query = new URLSearchParams({ agent: child.rootId, workView: "subagents:workspace", subagent: child.id, message: message.id });
        return new Response(null, { status: 303, headers: { location: `/workspaces/${encodeURIComponent(workspaceId)}?${query}` } });
      }
      return handleSubagentRequest(request, url, { events: context.events });
    },
  }],
};
