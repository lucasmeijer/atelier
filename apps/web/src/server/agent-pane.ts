import { actionItemHtml } from "@atelier/design-system/action-item";
import { buttonHtml } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { panelHtml } from "@atelier/design-system/panel";
import { popupHtml } from "@atelier/design-system/popup";
import { domId, escapeHtml } from "@atelier/shared";
import type { WorkspacePresentation } from "./workspace-presentation.ts";
import { barButton, behaviorTurboStream, busyAttentionIndicator, fullscreenViewAttributes, selectorCloseForm, type ViewCloseAction } from "./workspace-view-markup.ts";

export interface AgentPaneContribution {
  bodyHtml?: string;
  busy?: boolean;
  requestingAttention?: boolean;
  attentionSequence?: number;
  untitled?: boolean;
  id: string;
  providerId: string;
  iconHtml: string;
  title: string;
  close?: ViewCloseAction;
}

export function agentNavigationDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_navigation");
}

function agentTabListDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_tab_list");
}

export function agentBodiesDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_bodies");
}

export function agentActionsDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_actions");
}

export function agentTabDomId(workspaceId: string, conversationId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_tab", conversationId);
}

export function agentPaneSlotDomId(workspaceId: string, conversationId: string): string {
  return domId("fixed_workspace", workspaceId, "agent_pane", conversationId);
}

export function agentContentId(workspaceId: string, conversationId: string): string {
  return domId("agent_content", workspaceId, conversationId);
}

function agentStateDomId(workspaceId: string, conversationId: string): string { return domId("agent_state", workspaceId, conversationId); }

function renderAgentState(workspaceId: string, conversationId: string, state: { busy?: boolean; requestingAttention?: boolean; attentionSequence?: number }): string {
  return `<span id="${agentStateDomId(workspaceId, conversationId)}" data-agent-attention-id="${escapeHtml(conversationId)}"${state.attentionSequence === undefined ? "" : ` data-attention-sequence="${state.attentionSequence}"`}${state.busy || state.requestingAttention ? "" : " hidden"}>${busyAttentionIndicator(state)}</span>`;
}

function mobileAgentAttentionHtml(agents: readonly AgentPaneContribution[]): string {
  return agents.some((agent) => agent.requestingAttention) ? '<i class="status-dot attention" aria-label="Agent requesting attention"></i>' : "";
}

export function renderMobileAgentAttention(workspaceId: string, agents: readonly AgentPaneContribution[]): string {
  return `<span id="${domId("mobile_agent_attention", workspaceId)}">${mobileAgentAttentionHtml(agents)}</span>`;
}

function renderAgentTab(workspaceId: string, agent: AgentPaneContribution): string {
  return `<div class="fixed-shell-agent-tab">${actionItemHtml({
    kind: "compound",
    label: { kind: "text", text: agent.title },
    leadingHtml: `<span class="fixed-shell-agent-icon">${agent.iconHtml}</span>`,
    trailingHtml: renderAgentState(workspaceId, agent.id, agent),
    container: {  attributesHtml: `id="${agentTabDomId(workspaceId, agent.id)}"` },
    primary: { tag: "button", attributesHtml: `type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-conversation-id="${escapeHtml(agent.id)}" ${fullscreenViewAttributes(agent.id, agent.title)} data-action="click->workspace-presentation#selectAgent"` },
    engagedActionsHtml: agent.close ? selectorCloseForm(agent.close) : "",
  })}</div>`;
}

function providerOptions(presentation: WorkspacePresentation, menu: boolean): string {
  return presentation.agentProviders.map((provider) => {
    const action = `/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/agent.create.${encodeURIComponent(provider.id)}`;
    const item = actionItemHtml({
      kind: "single", label: { kind: "text", text: provider.label }, leadingHtml: provider.iconHtml,
      element: { tag: "button", attributesHtml: `type="submit"${menu ? ' role="menuitem"' : ""}` },
    });
    return `<form method="post" action="${action}" data-turbo="true">${item}</form>`;
  }).join("");
}

export function renderAgentNavigation(presentation: WorkspacePresentation): string {
  const conversations = presentation.agentConversations.length
    ? `<div id="${agentTabListDomId(presentation.workspace.id)}" class="fixed-shell-agent-conversations" role="tablist" aria-label="Agent conversations">${presentation.agentConversations.map((agent) => renderAgentTab(presentation.workspace.id, { ...agent, title: presentation.agentConversations.length === 1 && agent.untitled ? presentation.workspace.title : agent.title })).join("")}</div>`
    : `<div class="fixed-shell-workspace-title"><strong>${escapeHtml(presentation.workspace.title)}</strong></div>`;
  const menu = popupHtml({
    id: domId("agent_providers", presentation.workspace.id), label: "New agent",
    trigger: { variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "New agent" } },
    contentHtml: providerOptions(presentation, true),
  });
  return `${conversations}${menu}`;
}

function agentEmptyId(workspaceId: string): string { return domId("agent_empty", workspaceId); }

function renderAgentEmpty(presentation: WorkspacePresentation): string {
  return `<div id="${agentEmptyId(presentation.workspace.id)}" class="agent-empty-canvas"><div class="agent-empty-choices"><h2>Choose your first agent</h2><p>Start a conversation with an agent provider.</p><div class="action-list">${providerOptions(presentation, false)}</div></div></div>`;
}

function renderAgentPaneSlot(workspaceId: string, agent: AgentPaneContribution, active: boolean): string {
  return `<section id="${agentPaneSlotDomId(workspaceId, agent.id)}" class="fixed-shell-surface${active ? " is-active" : ""}" data-workspace-pane-role="agent" data-workspace-pane-id="${escapeHtml(agent.id)}" data-atelier-fullscreen-view-key="${escapeHtml(agent.id)}" data-workspace-logically-visible="false" tabindex="-1"><div class="fixed-shell-live-body" id="${agentContentId(workspaceId, agent.id)}" data-turbo-permanent>${agent.bodyHtml ?? ""}</div></section>`;
}

function renderAgentActions(presentation: WorkspacePresentation): string {
  const parkButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Park, label: "Park workspace" } });
  const parkWorkspace = `<form class="fixed-shell-park-workspace" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/park" data-action="submit->workspace-navigation#parkWorkspace">${parkButton}</form>`;
  const deleteConfirmation = destructiveConfirmationHtml({
    id: domId("delete_workspace", presentation.workspace.id),
    trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Trash, label: "Delete workspace" } },
    confirmCaption: "Yes, delete",
    cancelCaption: "Oops",
  });
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete">${deleteConfirmation}</form>`;
  const itemsHtml = `${parkWorkspace}${deleteWorkspace}${barButton("Show Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-show-work-pane")}`;
  return buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml });
}

export function renderAgentPane(presentation: WorkspacePresentation): string {
  const panes = presentation.agentConversations.map((agent) => renderAgentPaneSlot(presentation.workspace.id, agent, agent.id === (presentation.initialSelection?.agent ?? presentation.agentConversations[0]?.id))).join("");
  return `<div class="fixed-shell-agent-pane"><div class="workspace-warning-stack" id="${domId("workspace_warnings", presentation.workspace.id)}">${presentation.warningsHtml ?? ""}</div>${panelHtml({
    element: { tag: "section",  attributesHtml: 'data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent"' },
    headerHtml: `${barButton("Show Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-show-workspace-pane")}<div class="fixed-shell-agent-header-scroll"><div id="${agentNavigationDomId(presentation.workspace.id)}" class="fixed-shell-agent-navigation">${renderAgentNavigation(presentation)}</div><div id="${agentActionsDomId(presentation.workspace.id)}" class="fixed-shell-agent-actions">${renderAgentActions(presentation)}</div></div>`,
    bodyHtml: `<div id="${agentBodiesDomId(presentation.workspace.id)}" class="fixed-shell-agent-bodies">${panes || renderAgentEmpty(presentation)}</div>`,
  })}</div>`;
}

export function selectAgentTurboStream(workspaceId: string, conversationId: string): string {
  return behaviorTurboStream("select-agent", workspaceId, { "conversation-id": conversationId });
}
