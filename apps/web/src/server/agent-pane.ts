import { actionItemHtml } from "@atelier/design-system/action-item";
import { buttonHtml } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { popupHtml } from "@atelier/design-system/popup";
import { panelHtml } from "@atelier/design-system/panel";
import { domId, escapeHtml, turboStream } from "@atelier/shared";
import { barButton, fullscreenViewAttributes, selectorCloseForm, behaviorTurboStream, workspacePreparationInvalidatedTurboStream, type ViewCloseAction } from "./workspace-view-markup.ts";
import type { WorkspacePresentation } from "./workspace-presentation.ts";

export interface AgentPaneContribution {
  untitled?: boolean;
  id: string;
  providerId: string;
  iconHtml: string;
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
    leadingHtml: `<span class="fixed-shell-agent-icon">${agent.iconHtml}</span>`,
    container: {  attributesHtml: `id="${agentTabDomId(workspaceId, agent.id)}"` },
    primary: { tag: "button", attributesHtml: `type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-conversation-id="${escapeHtml(agent.id)}" ${fullscreenViewAttributes(agent.id, agent.title)} data-action="click->workspace-presentation#selectAgent"` },
    engagedActionsHtml: agent.close ? selectorCloseForm(agent.close) : "",
  });
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
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete">${deleteConfirmation}</form>`;
  const itemsHtml = `${parkWorkspace}${deleteWorkspace}${barButton("Show Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-show-work-pane")}`;
  return buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml });
}

export function renderAgentPane(presentation: WorkspacePresentation): string {
  const panes = presentation.agentConversations.map((agent) => renderAgentPaneSlot(presentation.workspace.id, agent)).join("");
  return `<div class="fixed-shell-agent-pane"><div class="workspace-warning-stack" id="${domId("workspace_warnings", presentation.workspace.id)}">${presentation.warningsHtml ?? ""}</div>${panelHtml({
    element: { tag: "section",  attributesHtml: 'data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent"' },
    headerHtml: `${barButton("Show Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-show-workspace-pane")}<span class="fixed-shell-agent-pane-icon" aria-hidden="true">${Icons.Agent}</span><div id="${agentNavigationDomId(presentation.workspace.id)}" class="fixed-shell-agent-navigation">${renderAgentNavigation(presentation)}</div><div id="${agentActionsDomId(presentation.workspace.id)}" class="fixed-shell-agent-actions">${renderAgentActions(presentation)}</div>`,
    bodyHtml: `<div id="${agentBodiesDomId(presentation.workspace.id)}" class="fixed-shell-agent-bodies">${panes || renderAgentEmpty(presentation)}</div>`,
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
  // Refresh choices and tabs once, without remounting existing agent bodies.
  const streams = [agentProviderChoicesTurboStream(presentation)];
  if (added) {
    streams.push(turboStream("remove", agentEmptyId(workspace.id)));
    streams.push(turboStream("append", agentBodiesDomId(workspace.id), renderAgentPaneSlot(workspace.id, added)));
  }
  if (options.removedConversationId) {
    streams.push(turboStream("remove", agentPaneSlotDomId(workspace.id, options.removedConversationId)));
  }
  if (options.selectConversationId) streams.push(selectAgentTurboStream(workspace.id, options.selectConversationId));
  if (options.removedConversationId && options.successorConversationId) {
    streams.push(selectAgentSuccessorTurboStream(workspace.id, options.removedConversationId, options.successorConversationId));
  }
  streams.push(workspacePreparationInvalidatedTurboStream(workspace.id));
  return streams.join("");
}


/** Refresh creation choices without remounting any running agent body. */
export function agentProviderChoicesTurboStream(presentation: WorkspacePresentation): string {
  const navigation = turboStream("update", agentNavigationDomId(presentation.workspace.id), renderAgentNavigation(presentation));
  return navigation + (presentation.agentConversations.length ? "" : turboStream("update", agentBodiesDomId(presentation.workspace.id), renderAgentEmpty(presentation)));
}
