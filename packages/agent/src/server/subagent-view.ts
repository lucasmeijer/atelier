import { ids } from "./render-context.ts";
import type { SubagentRecord } from "./subagent-runtime.ts";
import type { AgentLivePresentationSubscription } from "./runtime-types.ts";
import type { AtelierEventBus } from "@atelier/core";
import { Icons } from "@atelier/design-system/icons";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { requestAcceptsJson, type JsonValue } from "@atelier/core";
import { actionItemHtml } from "@atelier/design-system/action-item";
import type { WorkspaceModuleWorkViewAdapter, WorkspaceWorkViewPresentation } from "@atelier/shared";
import { escapeHtml as h, turboStream } from "./html.ts";
import { getSubagents, subagentConversation, subscribeSubagentChanges } from "./subagents.ts";
import { agentPath } from "./subagent-protocol.ts";
import { getWorkspaceAgentRuntime } from "./runtime.ts";
import { listWorkspaceAgentConversations } from "./session-store.ts";
import type { AgentRouteHandler } from "./route-support.ts";

export const subagentsWorkView: WorkspaceWorkViewPresentation = {
  reference: { type: "subagents" }, sourceKey: "subagents", label: "Subagents", kind: "contextual", availability: { phase: "live" },
};
export const subagentsWorkViewAdapter: WorkspaceModuleWorkViewAdapter = {
  type: "subagents",
  parseReference(value: JsonValue) {
    if (!Value.Check(Type.Object({ type: Type.Literal("subagents") }), value)) throw new Error("Invalid Subagents reference");
    return { type: "subagents" };
  },
  identity: () => "workspace",
  render({ workspaceId }) {
    return `<section class="subagents-view" data-controller="subagents" data-subagents-workspace-id-value="${h(workspaceId)}" data-subagents-url-value="/workspaces/${h(workspaceId)}/subagents" data-action="atelier:workspace-pane-visible@document->subagents#sync atelier:workspace-pane-hidden@document->subagents#sync visibilitychange@document->subagents#sync turbo:frame-load->subagents#loaded toggle->subagents#toggle:capture">
      <div class="subagents-scroll"><turbo-frame id="subagents-content-${h(workspaceId)}" data-subagents-target="frame" refresh="morph"></turbo-frame></div>
    </section>`;
  },
};

export const handleSubagentRequest: AgentRouteHandler = async (request, url, options) => {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/subagents(?:\/([^/]+)\/transcript)?$/);
  if (!match || request.method !== "GET") return undefined;
  const workspaceId = decodeURIComponent(match[1]!);
  const conversations = await listWorkspaceAgentConversations(workspaceId);
  const parentId = url.searchParams.get("agent") ?? conversations[0]?.conversationId;
  const parent = conversations.find((agent) => agent.conversationId === parentId);
  if (!parent) return new Response("Agent not found", { status: 404 });
  const coordinator = await getSubagents(workspaceId, options.events);
  const agents = coordinator.list(parent.conversationId);
  if (match[2]) {
    const child = agents.find((agent) => agent.id === decodeURIComponent(match[2]!));
    if (!child) return new Response("Subagent not found in selected tree", { status: 404 });
    const runtime = await getWorkspaceAgentRuntime(subagentConversation(workspaceId, child), { events: options.events });
    return new Response(`<turbo-frame id="subagent-transcript-${h(child.id)}" refresh="morph"><div id="${ids.transcript({ workspaceId, conversationId: child.id })}" class="agent-transcript">${(await runtime.paneState(url.searchParams.get("message") ?? undefined)).transcriptHtml}</div></turbo-frame>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (requestAcceptsJson(request)) return Response.json({ parent: { id: parentId, title: parent.title }, agents, messages: coordinator.state.messages.filter((message) => message.to === parentId || message.from === parentId || agents.some((agent) => agent.id === message.to || agent.id === message.from)) });
  const open = new Set(url.searchParams.getAll("open"));
  let revealed = agents.find((agent) => agent.id === url.searchParams.get("reveal"));
  while (revealed) { open.add(revealed.id); revealed = agents.find((agent) => agent.id === revealed!.parentId); }
  return new Response(`<turbo-frame id="subagents-content-${h(workspaceId)}" refresh="morph">${renderSubagentTree(workspaceId, parent.conversationId, agents, open)}</turbo-frame>`, { headers: { "content-type": "text/html; charset=utf-8" } });
};


function childrenId(workspaceId: string, parentId: string): string { return `subagent-children-${workspaceId}-${parentId}`; }
function summaryHtml(agent: SubagentRecord, agents: SubagentRecord[]): string {
  const tone = agent.status === "running" || agent.status === "starting" ? "running" : agent.status === "failed" ? "danger" : agent.status === "completed" ? "success" : "";
  return actionItemHtml({ kind: "single", element: { tag: "summary", attributesHtml: `id="subagent-summary-${h(agent.id)}"` }, leadingHtml: Icons.Disclosure, label: { kind: "text", text: agentPath({ agents, messages: [] }, agent.id) }, trailingHtml: `<span class="subagent-state"><span class="status-dot ${tone}"></span>${h(agent.status)}</span>` });
}
function branchHtml(workspaceId: string, agent: SubagentRecord, agents: SubagentRecord[], open: Set<string>): string {
  return `<details id="subagent-${h(agent.id)}" class="subagent-branch" data-subagent-id="${h(agent.id)}" data-subagents-target="branch"${open.has(agent.id) ? " open" : ""}>
    ${summaryHtml(agent, agents)}
    <div class="subagent-branch-body"><turbo-frame id="subagent-transcript-${h(agent.id)}" data-subagent-transcript><div id="${ids.transcript({ workspaceId, conversationId: agent.id })}" class="agent-transcript"></div></turbo-frame>${childrenHtml(workspaceId, agent.id, agents, open)}</div>
  </details>`;
}
function childrenHtml(workspaceId: string, parentId: string, agents: SubagentRecord[], open: Set<string>): string {
  return `<div id="${h(childrenId(workspaceId, parentId))}" class="action-list subagent-list">${agents.filter((agent) => agent.parentId === parentId).map((agent) => branchHtml(workspaceId, agent, agents, open)).join("")}</div>`;
}
function emptyHtml(workspaceId: string, empty: boolean): string {
  return `<div id="subagents-empty-${h(workspaceId)}" class="subagents-empty"${empty ? "" : " hidden"}>No delegated tasks for this agent yet.</div>`;
}
function renderSubagentTree(workspaceId: string, rootId: string, agents: SubagentRecord[], open = new Set<string>()): string {
  return childrenHtml(workspaceId, rootId, agents, open) + emptyHtml(workspaceId, agents.length === 0);
}

/** Snapshot first, then only changed tree rows. Existing transcript DOM is never replaced by status updates. */
export async function subscribeSubagentTree(workspaceId: string, rootId: string, listener: (html: string) => void, events?: AtelierEventBus): Promise<AgentLivePresentationSubscription> {
  const roots = await listWorkspaceAgentConversations(workspaceId);
  if (!roots.some((root) => root.conversationId === rootId)) throw new Error("Subagent root not found");
  const coordinator = await getSubagents(workspaceId, events);
  let previous = structuredClone(coordinator.list(rootId));
  const unsubscribe = subscribeSubagentChanges((changedWorkspace) => {
    if (changedWorkspace !== workspaceId) return;
    const current = structuredClone(coordinator.list(rootId));
    let html = "";
    for (const agent of previous) if (!current.some((candidate) => candidate.id === agent.id)) html += turboStream("remove", `subagent-${agent.id}`, "");
    for (const agent of current) {
      const before = previous.find((candidate) => candidate.id === agent.id);
      if (!before) {
        // Parent appends include their new descendants, so each branch is inserted once.
        if (agent.parentId === rootId || previous.some((candidate) => candidate.id === agent.parentId)) html += turboStream("append", childrenId(workspaceId, agent.parentId), branchHtml(workspaceId, agent, current, new Set()));
      } else if (summaryHtml(before, previous) !== summaryHtml(agent, current)) html += turboStream("replace", `subagent-summary-${agent.id}`, summaryHtml(agent, current));
    }
    if (!previous.length !== !current.length) html += turboStream("replace", `subagents-empty-${workspaceId}`, emptyHtml(workspaceId, current.length === 0));
    previous = current;
    if (html) listener(html);
  });
  listener(turboStream("update", `subagents-content-${workspaceId}`, renderSubagentTree(workspaceId, rootId, previous)));
  return { ready: Promise.resolve(), unsubscribe };
}

export async function findSubagentConversation(workspaceId: string, conversationId: string, events?: AtelierEventBus) {
  const coordinator = await getSubagents(workspaceId, events);
  const child = coordinator.state.agents.find((agent) => agent.id === conversationId);
  return child ? subagentConversation(workspaceId, child) : undefined;
}
