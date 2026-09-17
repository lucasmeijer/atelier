import { actionItemHtml } from "@atelier/design-system/action-item";
import { buttonHtml } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { panelHtml } from "@atelier/design-system/panel";
import { domId, escapeHtml, turboStream } from "@atelier/shared";
import { barButton, fullscreenViewAttributes, selectorCloseForm, behaviorTurboStream, workspacePreparationInvalidatedTurboStream, type ViewCloseAction } from "./workspace-view-markup.ts";
import type { WorkspacePresentation } from "./workspace-presentation.ts";

export interface AgentPaneContribution {
  untitled?: boolean;
  id: string;
  title: string;
  bodyUrl: string;
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

export function agentBodyFrameId(workspaceId: string, conversationId: string): string {
  return domId("agent_body", workspaceId, conversationId);
}

export function renderAgentBodyFrame(workspaceId: string, conversationId: string, bodyHtml: string): string {
  return `<turbo-frame id="${agentBodyFrameId(workspaceId, conversationId)}">${bodyHtml}</turbo-frame>`;
}

function renderAgentTab(workspaceId: string, agent: AgentPaneContribution): string {
  return actionItemHtml({
    kind: "compound",
    label: { kind: "text", text: agent.title },
    leadingHtml: `<span class="fixed-shell-agent-icon">${Icons.Agent}</span>`,
    container: {  attributesHtml: `id="${agentTabDomId(workspaceId, agent.id)}"` },
    primary: { tag: "button", attributesHtml: `type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-conversation-id="${escapeHtml(agent.id)}" ${fullscreenViewAttributes(agent.id, agent.title)} data-action="click->workspace-presentation#selectAgent"` },
    engagedActionsHtml: agent.close ? selectorCloseForm(agent.close) : "",
  });
}

function renderAgentNavigation(presentation: WorkspacePresentation): string {
  let conversations: string;
  if (presentation.agentConversations.length > 1) {
    conversations = `<div id="${agentTabListDomId(presentation.workspace.id)}" class="fixed-shell-agent-conversations" role="tablist" aria-label="Agent conversations">${presentation.agentConversations.map((agent) => renderAgentTab(presentation.workspace.id, agent)).join("")}</div>`;
  } else {
    const agent = presentation.agentConversations[0];
    const title = agent && !agent.untitled ? agent.title : presentation.workspace.title;
    conversations = `<div class="fixed-shell-workspace-title" ${fullscreenViewAttributes(agent!.id, title)} data-atelier-fullscreen-pane-header-value="true"><span class="fixed-shell-agent-icon">${Icons.Agent}</span><strong>${escapeHtml(title)}</strong></div>`;
  }
  const agentActions = (presentation.commands ?? []).filter((command) => command.placement === "agent-action").map((command) => {
    const button = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: command.label } });
    return `<form class="fixed-shell-new-agent" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}">${button}</form>`;
  }).join("");
  return `${conversations}${agentActions}`;
}

function renderAgentPaneSlot(workspaceId: string, agent: AgentPaneContribution): string {
  const loading = `<div class="agent-body-loading" role="status" aria-label="Loading ${escapeHtml(agent.title)}"><span class="status-spinner" aria-hidden="true"></span></div>`;
  const frame = `<turbo-frame id="${agentBodyFrameId(workspaceId, agent.id)}" src="${escapeHtml(agent.bodyUrl)}" loading="lazy" data-agent-body-hydration data-action="turbo:frame-render->workspace-presentation#bodyRendered turbo:frame-missing->workspace-presentation#bodyMissing turbo:frame-load->workspace-presentation#agentBodyLoaded">${loading}</turbo-frame>`;
  return `<section id="${agentPaneSlotDomId(workspaceId, agent.id)}" class="fixed-shell-surface" data-workspace-pane-role="agent" data-workspace-pane-id="${escapeHtml(agent.id)}" data-atelier-fullscreen-view-key="${escapeHtml(agent.id)}" data-workspace-logically-visible="false" tabindex="-1"><div class="fixed-shell-live-body">${frame}</div></section>`;
}

function renderAgentActions(presentation: WorkspacePresentation): string {
  const parkButton = buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Park, label: "Park workspace" } });
  const parkWorkspace = `<form class="fixed-shell-park-workspace" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/park" data-action="submit->workspace-navigation#parkWorkspace">${parkButton}</form>`;
  const deleteConfirmation = destructiveConfirmationHtml({
    trigger: { type: "button", variant: "danger", content: { kind: "icon-only", iconHtml: Icons.Trash, label: "Delete workspace" } },
    confirmCaption: "Yes, delete",
    cancelCaption: "Oops",
  });
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-action="turbo:submit-start->workspace-navigation#workspaceDeletionStarted" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete">${deleteConfirmation}</form>`;
  const notification = presentation.agentHeaderHtml ?? "";
  const itemsHtml = `${notification}${parkWorkspace}${deleteWorkspace}${barButton("Show Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-show-work-pane")}`;
  return buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml });
}

export function renderAgentPane(presentation: WorkspacePresentation): string {
  const panes = presentation.agentConversations.map((agent) => renderAgentPaneSlot(presentation.workspace.id, agent)).join("");
  return `<div class="fixed-shell-agent-pane"><div class="workspace-warning-stack" id="${domId("workspace_warnings", presentation.workspace.id)}">${presentation.warningsHtml ?? ""}</div>${panelHtml({
    element: { tag: "section",  attributesHtml: 'data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent"' },
    headerHtml: `${barButton("Show Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-show-workspace-pane")}<div id="${agentNavigationDomId(presentation.workspace.id)}" class="fixed-shell-agent-navigation">${renderAgentNavigation(presentation)}</div><div id="${agentActionsDomId(presentation.workspace.id)}" class="fixed-shell-agent-actions">${renderAgentActions(presentation)}</div>`,
    bodyHtml: `<div id="${agentBodiesDomId(presentation.workspace.id)}" class="fixed-shell-agent-bodies">${panes}</div>`,
  })}</div>`;
}

export function selectAgentTurboStream(workspaceId: string, conversationId: string): string {
  return behaviorTurboStream("select-agent", workspaceId, { "conversation-id": conversationId });
}

function selectAgentSuccessorTurboStream(workspaceId: string, closedConversationId: string, successorConversationId: string): string {
  return behaviorTurboStream("select-agent-successor", workspaceId, { "closed-conversation-id": closedConversationId, "successor-conversation-id": successorConversationId });
}

interface AgentTabsTurboStreamOptions {
  addedConversationId?: string;
  removedConversationId?: string;
  selectConversationId?: string;
  successorConversationId?: string;
}

export function agentTabsTurboStream(presentation: WorkspacePresentation, options: AgentTabsTurboStreamOptions = {}): string {
  const { workspace } = presentation;
  const added = options.addedConversationId === undefined
    ? undefined
    : presentation.agentConversations.find((agent) => agent.id === options.addedConversationId);
  if (options.addedConversationId !== undefined && !added) throw new Error(`Added Agent is missing from the presentation: ${options.addedConversationId}`);
  const streams = [turboStream("update", agentActionsDomId(workspace.id), renderAgentActions(presentation))];
  if (added) {
    // Replace only the navigation region so overlapping Agent creations converge
    // even when one response observes a later creation before it renders.
    streams.push(turboStream("update", agentNavigationDomId(workspace.id), renderAgentNavigation(presentation)));
    streams.push(turboStream("append", agentBodiesDomId(workspace.id), renderAgentPaneSlot(workspace.id, added)));
  } else if (!options.removedConversationId) {
    streams.push(turboStream("update", agentNavigationDomId(workspace.id), renderAgentNavigation(presentation)));
  }
  if (options.removedConversationId) {
    streams.push(turboStream("update", agentNavigationDomId(workspace.id), renderAgentNavigation(presentation)));
    streams.push(turboStream("remove", agentPaneSlotDomId(workspace.id, options.removedConversationId)));
  }
  if (options.selectConversationId) streams.push(selectAgentTurboStream(workspace.id, options.selectConversationId));
  if (options.removedConversationId && options.successorConversationId) {
    streams.push(selectAgentSuccessorTurboStream(workspace.id, options.removedConversationId, options.successorConversationId));
  }
  streams.push(workspacePreparationInvalidatedTurboStream(workspace.id));
  return streams.join("");
}

