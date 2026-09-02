import { untitledAgentConversationTitle } from "@atelier/agent/server";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { Icons } from "@atelier/design-system/icons";
import { panelHtml } from "@atelier/design-system/panel";
import { domId, escapeHtml, turboStream, workspaceWorkViewLabelDomId } from "@atelier/shared";
import type { WorkspaceDeletionState } from "./workspace-registry.ts";

export type WorkViewAvailability =
  | { phase: "opening"; detail?: string }
  | { phase: "live" }
  | { phase: "reconnecting"; detail?: string }
  | { phase: "unavailable"; detail: string; recoveryHtml?: string };

export type WorkspaceActionState = "starting" | "deleting" | "requires_delete_confirmation" | "idle";

export interface WorkspacePaneEntry {
  id: string;
  title: string;
  active?: boolean;
  state?: WorkspaceActionState;
  attention?: boolean;
  attentionAt?: number;
  attentionTokens?: Record<string, number>;
  lastActivityAt?: number;
  busyViewKeys?: readonly string[];
  outdated?: boolean;
}

export interface WorkspacePaneProject {
  id: string;
  title: string;
  workspaces: readonly WorkspacePaneEntry[];
  parkedWorkspaces?: readonly WorkspacePaneEntry[];
}

export interface ViewCloseAction {
  action: string;
  label: string;
}

export interface AgentPaneContribution {
  id: string;
  title: string;
  bodyUrl: string;
  close?: ViewCloseAction;
}

export interface WorkPaneContribution {
  /** Stable, type-native serialized identity supplied by the resource adapter. */
  key: string;
  label: string;
  labelHtml?: string;
  kind: "resource" | "contextual";
  attentionSequence?: number;
  availability: WorkViewAvailability;
  /** Inline bodies are reserved for shell-level fixtures; module attachments use bodyUrl. */
  bodyHtml?: string;
  bodyUrl?: string;
  sourceKey?: string;
  actionsHtml?: string;
  close?: ViewCloseAction;
}

export interface WorkspacePanePresentation {
  projects: readonly WorkspacePaneProject[];
  emptyProjects?: readonly Pick<WorkspacePaneProject, "id" | "title">[];
  projectlessWorkspaces?: readonly WorkspacePaneEntry[];
  projectlessParkedWorkspaces?: readonly WorkspacePaneEntry[];
}

export type WorkspacePaneOnboardingState = "first-project" | "first-workspace" | "workspaces";

export function workspacePaneOnboardingState(presentation: WorkspacePanePresentation): WorkspacePaneOnboardingState {
  const hasWorkspaces = presentation.projects.some((project) => project.workspaces.length > 0 || (project.parkedWorkspaces?.length ?? 0) > 0)
    || (presentation.projectlessWorkspaces?.length ?? 0) > 0
    || (presentation.projectlessParkedWorkspaces?.length ?? 0) > 0;
  if (hasWorkspaces) return "workspaces";
  return presentation.projects.length + (presentation.emptyProjects?.length ?? 0) > 0 ? "first-workspace" : "first-project";
}

export interface WorkspacePresentation {
  workspace: Pick<WorkspacePaneEntry, "id" | "title">;
  agentConversations: readonly AgentPaneContribution[];
  workViews: readonly WorkPaneContribution[];
  commands?: readonly { id: string; label: string; description?: string; scope: string; placement?: "work-launcher" | "agent-action"; binding?: string }[];
  overlayHtml?: readonly string[];
}

type WorkViewIconName = "Browser" | "Code" | "Files" | "Plus" | "Review" | "Terminal";

function topBarButton(label: string, action: string, iconHtml: string, attributes = ""): string {
  return `<button type="button" class="button secondary icon-only" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-action="${action}" ${attributes}>${iconHtml}</button>`;
}

function closeForm(close: ViewCloseAction, buttonHtml: string): string {
  return `<form data-turbo="true" method="post" action="${escapeHtml(close.action)}" data-close-label="${escapeHtml(close.label)}" data-action="submit->workspace-presentation#confirmClose">${buttonHtml}</form>`;
}

function fullscreenViewAttributes(key: string, title: string): string {
  return `data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="${escapeHtml(key)}" data-atelier-fullscreen-title-value="${escapeHtml(title)}"`;
}

function selectorCloseForm(close: ViewCloseAction): string {
  const label = escapeHtml(`Close ${close.label}`);
  const confirmation = destructiveConfirmationHtml({
    buttonHtml: `<button class="fixed-shell-view-close button danger icon-only" type="button" title="${label}" aria-label="${label}">${Icons.Close}</button>`,
    confirmCaption: "Yes, close",
    cancelCaption: "Oops",
  });
  return `<form data-turbo="true" method="post" action="${escapeHtml(close.action)}">${confirmation}</form>`;
}

function workspaceStatusSlot(content: string): string {
  return `<span class="fixed-shell-workspace-status action-item__status">${content}</span>`;
}

function renderWorkspaceRowStatus(workspace: WorkspacePaneEntry): string {
  if (workspace.state === "starting" || workspace.state === "deleting") {
    const label = workspace.state === "starting" ? "Workspace starting" : "Workspace deleting";
    return workspaceStatusSlot(`<i class="status-spinner sm fixed-shell-workspace-busy" aria-label="${label}" title="${label}"></i>`);
  }
  if (workspace.busyViewKeys?.length) {
    return workspaceStatusSlot('<i class="status-spinner sm fixed-shell-workspace-busy" aria-label="Workspace busy" title="Workspace busy"></i>');
  }
  if (workspace.attention) {
    return '<span class="workspace-attention-status fixed-shell-workspace-status action-item__status" aria-label="Attention"><i class="status-dot attention at-edge" aria-hidden="true"></i></span>';
  }
  return workspace.outdated
    ? workspaceStatusSlot('<i class="fixed-shell-workspace-warning" aria-label="Workspace created with an older version of Atelier" title="Some newer features may require a new workspace">⚠︎</i>')
    : "";
}

function renderWorkspaceRow(workspace: WorkspacePaneEntry, projectId?: string, options: { unpark?: boolean } = {}): string {
  const attentionAt = workspace.attentionAt === undefined ? "" : ` data-workspace-attention-at="${workspace.attentionAt}"`;
  const attentionTokens = workspace.attentionTokens === undefined ? "" : ` data-workspace-attention-tokens="${escapeHtml(JSON.stringify(workspace.attentionTokens))}"`;
  const lastActivityAt = workspace.lastActivityAt === undefined ? "" : ` data-workspace-last-activity-at="${workspace.lastActivityAt}"`;
  const project = projectId ? ` data-project-id="${escapeHtml(projectId)}"` : "";
  const busyViews = workspace.busyViewKeys?.length ? ` data-workspace-busy-views="${escapeHtml(JSON.stringify(workspace.busyViewKeys))}"` : "";
  const label = options.unpark ? `Unpark and open ${workspace.title}` : workspace.title;
  return actionItemHtml({
    kind: "single",
    label: { kind: "text", text: workspace.title },
    trailingHtml: renderWorkspaceRowStatus(workspace),
    element: {
      tag: "button",
      className: `fixed-shell-workspace-row${workspace.active ? " active" : ""}`,
      attributesHtml: `type="${options.unpark ? "submit" : "button"}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"${workspace.active ? ' aria-current="page"' : ""} data-workspace-entry-id="${escapeHtml(workspace.id)}"${attentionAt}${attentionTokens}${lastActivityAt}${busyViews}${project}${options.unpark ? "" : ' data-action="click->workspace-navigation#selectWorkspace"'}`,
    },
  });
}

const projectlessWorkspaceGroupId = "__projectless__";
const projectsDrawerGroupId = "__projects_drawer__";

interface WorkspaceGroupAddAction {
  href: string;
  frame: "launch_composer" | "project_editor_frame";
  label: string;
}

const projectEditorTarget = 'data-turbo-frame="project_editor_frame" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="project-editor-modal"';

interface WorkspaceGroupHeadingOptions {
  mode?: "disclosure" | "static" | "launcher";
  expanded?: boolean;
  settingsHref?: string;
  onboardingDestination?: Exclude<WorkspacePaneOnboardingState, "workspaces">;
}

function renderWorkspaceGroupHeading(id: string, title: string, add: WorkspaceGroupAddAction, options: WorkspaceGroupHeadingOptions = {}): string {
  const mode = options.mode ?? "disclosure";
  const escapedTitle = escapeHtml(title);
  const addTarget = add.frame === "project_editor_frame" ? projectEditorTarget : 'data-turbo-frame="launch_composer"';
  const primary = mode === "disclosure"
    ? { tag: "button" as const, className: "fixed-shell-project-heading", attributesHtml: `type="button" aria-expanded="${options.expanded ?? true}" data-action="click->workspace-navigation#toggleProject" data-project-id="${escapeHtml(id)}"` }
    : mode === "launcher"
      ? { tag: "a" as const, className: "fixed-shell-project-heading", attributesHtml: `href="${escapeHtml(add.href)}" ${addTarget} aria-label="${escapeHtml(add.label)}"` }
      : { tag: "span" as const, className: "fixed-shell-project-heading fixed-shell-project-heading-static" };
  const settings = options.settingsHref ? `<a class="fixed-shell-project-settings button secondary icon-only" href="${escapeHtml(options.settingsHref)}" ${projectEditorTarget} aria-label="Project settings: ${escapedTitle}" title="Project settings: ${escapedTitle}">${Icons.More}</a>` : "";
  const onboardingClass = options.onboardingDestination ? " is-onboarding-target" : "";
  const onboardingAttribute = options.onboardingDestination ? ` data-empty-workspace-onboarding-destination="${options.onboardingDestination}"` : "";
  const actions = `<span class="fixed-shell-project-actions button-group">${settings}<a class="fixed-shell-project-add button secondary icon-only${onboardingClass}"${onboardingAttribute} href="${escapeHtml(add.href)}" ${addTarget} aria-label="${escapeHtml(add.label)}" title="${escapeHtml(add.label)}">${Icons.Plus}</a></span>`;
  return actionItemHtml({ kind: "compound", label: { kind: "text", text: title }, leadingHtml: mode === "disclosure" ? Icons.Disclosure : "", container: { className: "fixed-shell-project-heading-row" }, primary, engagedActionsHtml: actions });
}

function renderProjectHeading(project: Pick<WorkspacePaneProject, "id" | "title">, mode: "disclosure" | "launcher" = "disclosure", onboardingDestination?: Exclude<WorkspacePaneOnboardingState, "workspaces">): string {
  const id = encodeURIComponent(project.id);
  return renderWorkspaceGroupHeading(project.id, project.title, { href: `/projects/${id}/launch-composer`, frame: "launch_composer", label: `New workspace: ${project.title}` }, { mode, settingsHref: `/projects/${id}/editor`, onboardingDestination });
}

function renderParkedWorkspaceGroup(workspaces: readonly WorkspacePaneEntry[], parentId: string): string {
  if (workspaces.length === 0) return "";
  const groupId = `${parentId}:parked`;
  const heading = actionItemHtml({
    kind: "compound",
    label: { kind: "text", text: `${workspaces.length} parked` },
    leadingHtml: Icons.Disclosure,
    container: { className: "fixed-shell-project-heading-row" },
    primary: { tag: "button", className: "fixed-shell-project-heading", attributesHtml: `type="button" aria-expanded="false" data-action="click->workspace-navigation#toggleProject" data-project-id="${escapeHtml(groupId)}"` },
  });
  return `<section class="fixed-shell-project action-list fixed-shell-parked is-collapsed" data-project-id="${escapeHtml(groupId)}">
    ${heading}
    <div class="fixed-shell-project-workspaces action-list">${workspaces.map((workspace) => `<form method="post" action="/workspaces/${encodeURIComponent(workspace.id)}/unpark" data-workspace-entry-id="${escapeHtml(workspace.id)}" data-action="submit->workspace-navigation#unparkWorkspace">${renderWorkspaceRow(workspace, undefined, { unpark: true })}</form>`).join("")}</div>
  </section>`;
}

interface WorkspacePaneCollectionRegions {
  scrollHtml: string;
  projectsDrawerHtml: string;
}

function renderWorkspacePaneCollectionRegions(presentation: WorkspacePanePresentation): WorkspacePaneCollectionRegions {
  const projects = presentation.projects.map((project) => `<section class="fixed-shell-project action-list" data-project-id="${escapeHtml(project.id)}">
    ${renderProjectHeading(project)}
    <div class="fixed-shell-project-workspaces action-list">${project.workspaces.map((workspace) => renderWorkspaceRow(workspace, project.id)).join("")}${renderParkedWorkspaceGroup(project.parkedWorkspaces ?? [], project.id)}</div>
  </section>`).join("");
  const projectlessWorkspaces = presentation.projectlessWorkspaces ?? [];
  const projectlessParkedWorkspaces = presentation.projectlessParkedWorkspaces ?? [];
  const projectlessAdd = { href: "/launch-composer", frame: "launch_composer", label: "New projectless workspace" } as const;
  const projectless = `<section class="fixed-shell-project action-list" data-project-id="${projectlessWorkspaceGroupId}">
    ${renderWorkspaceGroupHeading(projectlessWorkspaceGroupId, "Projectless", projectlessAdd, { mode: projectlessWorkspaces.length > 0 || projectlessParkedWorkspaces.length > 0 ? "disclosure" : "static" })}
    ${projectlessWorkspaces.length > 0 || projectlessParkedWorkspaces.length > 0 ? `<div class="fixed-shell-project-workspaces action-list">${projectlessWorkspaces.map((workspace) => renderWorkspaceRow(workspace)).join("")}${renderParkedWorkspaceGroup(projectlessParkedWorkspaces, projectlessWorkspaceGroupId)}</div>` : ""}
  </section>`;
  const drawerProjects = [...presentation.projects, ...(presentation.emptyProjects ?? [])].sort((left, right) => left.title.localeCompare(right.title));
  const onboardingState = workspacePaneOnboardingState(presentation);
  const needsFirstProject = onboardingState === "first-project";
  const needsFirstWorkspace = onboardingState === "first-workspace";
  const projectsDrawerHtml = `<section id="${workspaceProjectsDrawerDomId}" class="fixed-shell-project action-list fixed-shell-projects-drawer${needsFirstWorkspace ? "" : " is-collapsed"}" data-project-id="${projectsDrawerGroupId}">
    ${renderWorkspaceGroupHeading(projectsDrawerGroupId, "Projects", { href: "/projects/new/editor", frame: "project_editor_frame", label: "New project" }, { expanded: needsFirstWorkspace, onboardingDestination: needsFirstProject ? "first-project" : undefined })}
    <div class="fixed-shell-project-workspaces action-list">${drawerProjects.map((project, index) => `<section class="fixed-shell-project action-list">${renderProjectHeading(project, "launcher", needsFirstWorkspace && index === 0 ? "first-workspace" : undefined)}</section>`).join("")}</div>
  </section>`;
  return { scrollHtml: `${projects}${projectless}`, projectsDrawerHtml };
}

function renderWorkspacePaneCollections(presentation: WorkspacePanePresentation, sidebarContributionsHtml = ""): string {
  const regions = renderWorkspacePaneCollectionRegions(presentation);
  return `<div class="fixed-shell-pane-collections" data-workspace-pane-collections>
    <div id="${workspacePaneScrollDomId}" class="fixed-shell-workspace-scroll" data-workspace-navigation-target="scroll">${regions.scrollHtml}</div>
    <section id="global_sidebar_contributions">${sidebarContributionsHtml}</section>
    ${regions.projectsDrawerHtml}
  </div>`;
}

const workspacePaneScrollDomId = "fixed_shell_workspace_scroll";
const workspaceProjectsDrawerDomId = "fixed_shell_projects_drawer";

export function renderWorkspacePane(presentation: WorkspacePanePresentation, sidebarContributionsHtml = ""): string {
  const settings = `<a class="button secondary icon-only" href="/settings" title="Settings" aria-label="Settings" data-controller="settings-prefetch" data-action="pointerenter->settings-prefetch#prefetch focus->settings-prefetch#prefetch click->settings-prefetch#open">${Icons.Settings}</a>`;
  return panelHtml({
    element: { tag: "aside", className: "fixed-shell-workspace-pane", attributesHtml: 'aria-label="Workspaces"' },
    headerHtml: `<strong class="panel__title">${Icons.Atelier}Atelier</strong><div class="button-group">${settings}${topBarButton("Collapse Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-collapse-workspace-pane")}</div>`,
    bodyHtml: renderWorkspacePaneCollections(presentation, sidebarContributionsHtml),
  });
}

const atelierNextUnreadDomId = "fixed_shell_atelier_next_unread";

function workspacePaneHasAttention(presentation: WorkspacePanePresentation): boolean {
  return presentation.projects.some((project) => [...project.workspaces, ...(project.parkedWorkspaces ?? [])].some((workspace) => workspace.attention))
    || [...(presentation.projectlessWorkspaces ?? []), ...(presentation.projectlessParkedWorkspaces ?? [])].some((workspace) => workspace.attention);
}

function renderAtelierNextUnreadButton(presentation: WorkspacePanePresentation): string {
  const disabled = workspacePaneHasAttention(presentation) ? "" : " disabled";
  return actionItemHtml({
    kind: "single",
    contentHtml: Icons.Next,
    element: { tag: "button", className: "fixed-shell-atelier-action", attributesHtml: `id="${atelierNextUnreadDomId}" type="button" aria-label="Next unread Workspace" title="Next unread Workspace"${disabled} data-action="click->atelier-shortcuts#openOldestAttentionWorkspace"` },
  });
}

export function renderAtelierBar(presentation: WorkspacePanePresentation): string {
  const workspace = actionItemHtml({
    kind: "single",
    contentHtml: Icons.Workspace,
    element: { tag: "button", className: "fixed-shell-mobile-fixed", attributesHtml: 'type="button" aria-label="Show Workspace pane" title="Show Workspace pane" aria-expanded="false" data-mobile-workspace-destination data-action="click->workspace-navigation#toggleWorkspacePane"' },
  });
  return `<nav class="fixed-shell-mobile-nav fixed-shell-atelier-bar button-group" aria-label="Atelier">${workspace}${renderAtelierNextUnreadButton(presentation)}</nav>`;
}

export function workspacePresentationDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId);
}

function workspaceRegionDomId(workspaceId: string, part: string): string {
  return domId("fixed_workspace", workspaceId, part);
}

export function agentNavigationDomId(workspaceId: string): string {
  return workspaceRegionDomId(workspaceId, "agent_navigation");
}

export function agentTabListDomId(workspaceId: string): string {
  return workspaceRegionDomId(workspaceId, "agent_tab_list");
}

export function agentBodiesDomId(workspaceId: string): string {
  return workspaceRegionDomId(workspaceId, "agent_bodies");
}

export function agentActionsDomId(workspaceId: string): string {
  return workspaceRegionDomId(workspaceId, "agent_actions");
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
    container: { className: "fixed-shell-agent-conversation", attributesHtml: `id="${agentTabDomId(workspaceId, agent.id)}"` },
    primary: { tag: "button", attributesHtml: `type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-conversation-id="${escapeHtml(agent.id)}" ${fullscreenViewAttributes(agent.id, agent.title)} data-action="click->workspace-presentation#selectAgent"` },
    engagedActionsHtml: agent.close ? selectorCloseForm(agent.close) : "",
  });
}

function renderAgentNavigation(presentation: WorkspacePresentation): string {
  const multiple = presentation.agentConversations.length > 1;
  if (multiple) return `<div id="${agentTabListDomId(presentation.workspace.id)}" class="fixed-shell-agent-conversations" role="tablist" aria-label="Agent conversations">${presentation.agentConversations.map((agent) => renderAgentTab(presentation.workspace.id, agent)).join("")}</div>`;
  const agent = presentation.agentConversations[0];
  const title = agent && agent.title !== untitledAgentConversationTitle ? agent.title : presentation.workspace.title;
  return `<div class="fixed-shell-workspace-title"><span class="fixed-shell-agent-icon">${Icons.Agent}</span><strong>${escapeHtml(title)}</strong></div>`;
}

function renderAgentPaneSlot(workspaceId: string, agent: AgentPaneContribution): string {
  const loading = `<div class="agent-body-loading" role="status" aria-label="Loading ${escapeHtml(agent.title)}"><span class="status-spinner" aria-hidden="true"></span></div>`;
  const frame = `<turbo-frame id="${agentBodyFrameId(workspaceId, agent.id)}" src="${escapeHtml(agent.bodyUrl)}" loading="lazy" data-agent-body-hydration data-action="turbo:frame-load->workspace-presentation#agentBodyLoaded">${loading}</turbo-frame>`;
  return `<section id="${agentPaneSlotDomId(workspaceId, agent.id)}" class="fixed-shell-surface" data-workspace-pane-role="agent" data-workspace-pane-id="${escapeHtml(agent.id)}" data-atelier-fullscreen-view-key="${escapeHtml(agent.id)}" data-workspace-logically-visible="false" tabindex="-1"><div class="fixed-shell-live-body">${frame}</div></section>`;
}

function renderAgentActions(presentation: WorkspacePresentation): string {
  const agentActions = (presentation.commands ?? []).filter((command) => command.placement === "agent-action").map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button class="button secondary icon-only" type="submit" title="${escapeHtml(command.label)}" aria-label="${escapeHtml(command.label)}">${Icons.Plus}</button></form>`).join("");
  const parkWorkspace = `<form class="fixed-shell-park-workspace" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/park" data-action="submit->workspace-navigation#parkWorkspace"><button class="button secondary icon-only" type="submit" title="Park workspace" aria-label="Park workspace">${Icons.Park}</button></form>`;
  const deleteConfirmation = destructiveConfirmationHtml({
    buttonHtml: `<button class="button danger icon-only" type="button" title="Delete workspace" aria-label="Delete workspace">${Icons.Trash}</button>`,
    confirmCaption: "Yes, delete",
    cancelCaption: "Oops",
  });
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete">${deleteConfirmation}</form>`;
  return `${agentActions}${parkWorkspace}${deleteWorkspace}${topBarButton("Show Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-show-work-pane")}`;
}

function renderAgentPane(presentation: WorkspacePresentation): string {
  const panes = presentation.agentConversations.map((agent) => renderAgentPaneSlot(presentation.workspace.id, agent)).join("");
  return panelHtml({
    element: { tag: "section", className: "fixed-shell-agent-pane", attributesHtml: 'data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent"' },
    headerHtml: `${topBarButton("Show Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-show-workspace-pane")}<div id="${agentNavigationDomId(presentation.workspace.id)}" class="fixed-shell-agent-navigation">${renderAgentNavigation(presentation)}</div><div id="${agentActionsDomId(presentation.workspace.id)}" class="fixed-shell-agent-actions button-group">${renderAgentActions(presentation)}</div>`,
    bodyHtml: `<div id="${agentBodiesDomId(presentation.workspace.id)}" class="fixed-shell-agent-bodies">${panes}</div>`,
  });
}

function renderAvailability(view: WorkPaneContribution): string {
  const { availability } = view;
  if (availability.phase === "live") return "";
  const label = availability.phase === "opening" ? "Opening" : availability.phase === "reconnecting" ? "Reconnecting" : "Unavailable";
  const detail = availability.detail ?? (availability.phase === "opening" ? `Opening ${view.label}…` : `Reconnecting ${view.label}…`);
  return `<div class="fixed-shell-availability empty-state fixed-shell-availability-${availability.phase}" role="${availability.phase === "unavailable" ? "alert" : "status"}">
    <span class="fixed-shell-availability-mark" aria-hidden="true"></span><strong>${label}</strong><p>${escapeHtml(detail)}</p>${availability.phase === "unavailable" ? availability.recoveryHtml ?? "" : ""}
  </div>`;
}

function renderWorkViewSelector(workspaceId: string, view: WorkPaneContribution): string {
  const iconName = workViewIcon(view);
  const textAttributesHtml = `id="${workspaceWorkViewLabelDomId(workspaceId, view.key)}"`;
  return actionItemHtml({
    kind: "compound",
    label: view.labelHtml === undefined
      ? { kind: "text", text: view.label, textAttributesHtml }
      : { kind: "html", html: view.labelHtml, textAttributesHtml },
    leadingHtml: `<span class="fixed-shell-work-view-icon" data-icon="${iconName.toLowerCase()}">${Icons[iconName]}</span>`,
    trailingHtml: view.attentionSequence === undefined ? "" : '<i class="status-dot attention action-item__status" aria-label="Attention"></i>',
    container: {
      className: "fixed-shell-work-view-selector",
      attributesHtml: `id="${workViewSelectorDomId(workspaceId, view.key)}" draggable="true" data-work-view-reorder-key="${escapeHtml(view.key)}" data-action="dragstart->workspace-presentation#beginWorkReorder dragover->workspace-presentation#allowWorkReorder drop->workspace-presentation#finishWorkReorder"`,
    },
    primary: { tag: "button", attributesHtml: `type="button" role="tab" aria-selected="false" tabindex="-1" data-work-view-key="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}"${view.attentionSequence === undefined ? "" : ` data-attention-sequence="${view.attentionSequence}"`} ${fullscreenViewAttributes(view.sourceKey ?? view.key, view.label)} data-action="click->workspace-presentation#selectWorkView"` },
    engagedActionsHtml: view.close ? selectorCloseForm(view.close) : "",
  });
}

function renderWorkViewSelectors(workspaceId: string, views: readonly WorkPaneContribution[]): string {
  return views.map((view) => renderWorkViewSelector(workspaceId, view)).join("");
}

function renderWorkViewPane(workspaceId: string, view: WorkPaneContribution): string {
  const body = view.bodyHtml ?? (view.bodyUrl
    ? `<turbo-frame id="${workViewBodyFrameId(workspaceId, view.key)}" src="${escapeHtml(view.bodyUrl)}" loading="lazy" data-work-view-hydration data-action="turbo:before-frame-render->workspace-presentation#workBodyWillRender turbo:frame-load->workspace-presentation#workBodyLoaded"><div class="work-view-hydration-loading" role="status" aria-label="Loading ${escapeHtml(view.label)}"><span class="status-spinner" aria-hidden="true"></span></div></turbo-frame>`
    : "");
  const source = view.sourceKey ? ` data-source-work-view-key="${escapeHtml(view.sourceKey)}"` : "";
  return `<section id="${workViewPaneDomId(workspaceId, view.key)}" class="fixed-shell-surface" data-workspace-pane-role="work" data-workspace-pane-id="${escapeHtml(view.key)}" data-atelier-fullscreen-view-key="${escapeHtml(view.sourceKey ?? view.key)}" data-workspace-logically-visible="false"${source} tabindex="-1"><div id="${workViewAvailabilityDomId(workspaceId, view.key)}">${renderAvailability(view)}</div><div id="${workViewActionsDomId(workspaceId, view.key)}" class="fixed-shell-work-actions">${view.actionsHtml ?? ""}</div><div class="fixed-shell-live-body">${body}</div></section>`;
}

export function workViewBodyFrameId(workspaceId: string, key: string): string {
  return domId("work_view_body", workspaceId, key);
}

export function renderWorkViewBodyFrame(workspaceId: string, key: string, bodyHtml: string): string {
  return `<turbo-frame id="${workViewBodyFrameId(workspaceId, key)}">${bodyHtml}</turbo-frame>`;
}

function workViewDomId(workspaceId: string, part: string): string {
  return workspaceRegionDomId(workspaceId, part);
}

export function workViewSelectorDomId(workspaceId: string, key: string): string {
  return domId("work_view_selector", workspaceId, key);
}

export function workViewPaneDomId(workspaceId: string, key: string): string {
  return domId("work_view_pane", workspaceId, key);
}

export function workViewAvailabilityDomId(workspaceId: string, key: string): string {
  return domId("work_view_availability", workspaceId, key);
}

export function workViewActionsDomId(workspaceId: string, key: string): string {
  return domId("work_view_actions", workspaceId, key);
}

function workViewType(view: WorkPaneContribution): string {
  return view.key.slice(0, view.key.indexOf(":"));
}

function workViewIcon(view: WorkPaneContribution): WorkViewIconName {
  return workViewTypeIcon(workViewType(view));
}

function workViewTypeIcon(type: string): WorkViewIconName {
  switch (type) {
    case "browser": return "Browser";
    case "files": return "Files";
    case "review": return "Review";
    case "terminal": return "Terminal";
    case "vscode": return "Code";
    default: return "Plus";
  }
}

function workLauncherIcon(commandId: string): WorkViewIconName {
  return workViewTypeIcon(commandId.slice(0, commandId.indexOf(".")));
}

function renderWorkLauncherCommand(command: NonNullable<WorkspacePresentation["commands"]>[number], workspaceId: string, action = ""): string {
  const item = actionItemHtml({ kind: "single", label: { kind: "text", text: command.label }, leadingHtml: `<span class="popup-menu__icon">${Icons[workLauncherIcon(command.id)]}</span>`, element: { tag: "button", attributesHtml: 'type="submit" role="menuitem"' } });
  const actionAttribute = action ? ` data-action="${action}"` : "";
  return `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(command.id)}"${actionAttribute}>${item}</form>`;
}

function renderWorkPane(presentation: WorkspacePresentation): string {
  const selectors = renderWorkViewSelectors(presentation.workspace.id, presentation.workViews);
  const panes = presentation.workViews.map((view) => renderWorkViewPane(presentation.workspace.id, view)).join("");
  const workCommands = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher");
  const addMenuId = workViewDomId(presentation.workspace.id, "add_menu");
  const addMenu = workCommands.length ? `<span class="popup-menu-anchor"><button class="button primary icon-only popup-menu-trigger" type="button" title="Open Work view" aria-label="Open Work view" aria-haspopup="menu" aria-controls="${addMenuId}" popovertarget="${addMenuId}">${Icons.Plus}</button><div class="popup-menu action-list popup-menu-anchored" id="${addMenuId}" role="menu" aria-label="Open Work view" popover="auto">${workCommands.map((command) => renderWorkLauncherCommand(command, presentation.workspace.id)).join("")}</div></span>` : "";
  return panelHtml({
    element: { tag: "section", className: "fixed-shell-work-pane", attributesHtml: 'data-workspace-role-region="work" data-workspace-presentation-target="workPane" aria-label="Work"' },
    headerHtml: `<div id="${workViewDomId(presentation.workspace.id, "selectors")}" class="fixed-shell-work-view-selectors" role="tablist" aria-label="Work views">${selectors}</div><span id="${workViewDomId(presentation.workspace.id, "launchers")}">${addMenu}</span>${topBarButton("Collapse Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-collapse-work-pane")}`,
    bodyHtml: `<div id="${workViewDomId(presentation.workspace.id, "bodies")}" class="fixed-shell-work-bodies">${panes || `<div id="${workViewDomId(presentation.workspace.id, "empty")}" class="fixed-shell-empty-work empty-state">Open Files, a file, terminal, or browser to work alongside the Agent.</div>`}</div><div class="fixed-shell-work-resizer" role="separator" aria-label="Resize Work pane" aria-orientation="vertical" tabindex="0" data-action="pointerdown->workspace-presentation#beginWorkResize keydown->workspace-presentation#resizeWorkWithKeyboard"></div>`,
  });
}

function renderMobileDestination(label: string, destination: string, iconHtml: string, attention = false, workKey?: string): string {
  const attentionHtml = attention ? '<i class="status-dot attention" aria-label="Attention"></i>' : "";
  const workKeyAttribute = workKey === undefined ? "" : ` data-mobile-work-key="${escapeHtml(workKey)}"`;
  return actionItemHtml({
    kind: "single",
    contentHtml: `${iconHtml}${attentionHtml}`,
    element: { tag: "button", attributesHtml: `type="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${workKeyAttribute} data-mobile-destination="${escapeHtml(destination)}" data-action="click->workspace-presentation#selectMobileDestination"` },
  });
}

function mobileNavigationPriority(view: WorkPaneContribution): number {
  const type = workViewType(view);
  if (type === "browser") return 0;
  if (type === "review") return 1;
  return 2;
}

function renderMobileWorkViews(views: readonly WorkPaneContribution[]) {
  const ordered = [...views].sort((left, right) => mobileNavigationPriority(left) - mobileNavigationPriority(right));
  return {
    destinations: ordered.map((view) => renderMobileDestination(view.label, `work:${view.key}`, Icons[workViewIcon(view)], view.attentionSequence !== undefined, view.key)).join(""),
    overflowItems: ordered.map((view) => {
      const iconName = workViewIcon(view);
      const attention = view.attentionSequence === undefined ? "" : '<i class="status-dot attention action-item__status" aria-label="Attention"></i>';
      return actionItemHtml({
        kind: "single",
        label: { kind: "text", text: view.label },
        leadingHtml: `<span class="fixed-shell-work-view-icon" data-icon="${iconName.toLowerCase()}">${Icons[iconName]}</span>`,
        trailingHtml: attention,
        element: { tag: "button", attributesHtml: `type="button" role="menuitemradio" aria-checked="false" hidden data-more-work-key="${escapeHtml(view.key)}" data-more-work-kind="${view.kind}" data-action="click->workspace-presentation#selectMoreWorkView"` },
      });
    }).join(""),
  };
}

function renderMobileCloser(destination: string, close: ViewCloseAction): string {
  const item = actionItemHtml({ kind: "single", label: { kind: "text", text: "Close current view" }, leadingHtml: `<span class="popup-menu__icon">${Icons.Close}</span>`, element: { tag: "button", className: "is-danger", attributesHtml: 'type="submit" role="menuitem"' } });
  return `<div data-more-close-destination="${escapeHtml(destination)}" hidden>${closeForm(close, item)}</div>`;
}

function renderMobileWorkViewCloser(view: WorkPaneContribution): string {
  return view.close ? renderMobileCloser(`work:${view.key}`, view.close) : "";
}

const mobileLauncherCommandIds = new Set(["files.create", "terminal.create", "terminal.attach", "browser.create", "vscode.open"]);
const mobileMoreAttentionHtml = '<i class="status-dot attention" aria-label="Hidden Attention" data-mobile-overflow-attention hidden></i>';

function renderWorkspaceBar(presentation: WorkspacePresentation): string {
  const agentsDestination = renderMobileDestination("Agents", "agents", Icons.Agent);
  const workViews = renderMobileWorkViews(presentation.workViews);
  const launchers = (presentation.commands ?? []).filter((command) => mobileLauncherCommandIds.has(command.id)).map((command) => renderWorkLauncherCommand(command, presentation.workspace.id, "submit->workspace-presentation#closeMore")).join("");
  const closers = presentation.workViews.map(renderMobileWorkViewCloser).join("");
  const moreMenuId = workViewDomId(presentation.workspace.id, "mobile_more_menu");
  const more = actionItemHtml({
    kind: "single",
    contentHtml: `${Icons.More}<span id="${workViewDomId(presentation.workspace.id, "mobile_more_attention")}">${mobileMoreAttentionHtml}</span>`,
    element: { tag: "button", className: "fixed-shell-mobile-fixed", attributesHtml: `type="button" aria-label="More" title="More" aria-haspopup="menu" aria-controls="${moreMenuId}" data-mobile-more data-action="click->workspace-presentation#toggleMore"` },
  });
  return `<nav class="fixed-shell-mobile-nav fixed-shell-workspace-bar button-group" aria-label="Current Workspace destinations">
    <div class="fixed-shell-mobile-scroll button-group" data-mobile-overflow-container>${agentsDestination}<span id="${workViewDomId(presentation.workspace.id, "mobile_destinations")}" class="fixed-shell-mobile-work-items button-group">${workViews.destinations}</span></div>
    ${more}
    <div id="${moreMenuId}" class="fixed-shell-more-menu popup-menu action-list" data-workspace-presentation-target="moreMenu" role="menu" aria-label="More" hidden>
      <span id="${workViewDomId(presentation.workspace.id, "mobile_overflow")}" class="fixed-shell-mobile-work-items action-list">${workViews.overflowItems}</span>
      ${launchers ? `<hr class="popup-menu__separator" data-mobile-overflow-separator hidden>${launchers}` : ""}
      <div id="${workViewDomId(presentation.workspace.id, "mobile_closers")}" class="fixed-shell-more-close-section">${closers}</div>
    </div>
  </nav>`;
}

export function renderWorkspaceDeletionPresentation(workspaceId: string, deletion: WorkspaceDeletionState, evidenceHtml = ""): string {
  const id = encodeURIComponent(workspaceId);
  let content: string;
  if (deletion.status === "checking") {
    content = '<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>Checking if it’s safe to delete…</h1><p>Atelier is checking for uncommitted changes and unpushed commits.</p></div>';
  } else if (deletion.status === "deleting") {
    const title = deletion.forced ? "Force deleting workspace…" : "Deleting workspace…";
    const detail = deletion.forced ? "Local changes or unpushed commits may be discarded." : "The safety check passed. Atelier is removing the workspace.";
    content = `<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>${title}</h1><p>${detail}</p></div>`;
  } else if (deletion.status === "blocked") {
    content = `<div class="workspace-deletion-evidence" aria-label="Git work that may be lost">${evidenceHtml}</div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true"><button class="button secondary" type="submit">Cancel deletion</button></form><form method="post" action="/workspaces/${id}/delete/confirm" data-turbo="true"><input type="hidden" name="fingerprint" value="${escapeHtml(deletion.fingerprint)}"><button class="button danger" type="submit">${deletion.verification === "incomplete" ? "Delete without verification" : "Delete anyway"}</button></form></footer>`;
  } else {
    const bypass = deletion.operation === "checking" ? `<form method="post" action="/workspaces/${id}/delete?force=1" data-turbo="true"><button class="button danger" type="submit">Delete without verification</button></form>` : "";
    content = `<div class="workspace-deletion-heading"><h1>${deletion.operation === "checking" ? "Deletion could not be verified" : "Workspace deletion failed"}</h1><p class="workspace-deletion-error">${escapeHtml(deletion.error)}</p></div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true"><button class="button secondary" type="submit">Cancel deletion</button></form><form method="post" action="/workspaces/${id}/delete/retry" data-turbo="true"><button class="button secondary" type="submit">Retry verification</button></form>${bypass}</footer>`;
  }
  const role = deletion.status === "failed" ? ' role="alert"' : deletion.status === "blocked" ? "" : ' role="status"';
  return `<div id="${domId("fixed_workspace", workspaceId)}" class="fixed-workspace-presentation workspace-deletion-presentation" data-workspace-id="${escapeHtml(workspaceId)}" data-workspace-commands="[]"><main class="workspace-deletion-state" data-deletion-status="${deletion.status}"${role}>${content}</main></div>`;
}

export function renderWorkspacePresentation(presentation: WorkspacePresentation): string {
  if (presentation.agentConversations.length === 0) throw new Error("Workspace presentation requires an Agent conversation");
  const id = workspacePresentationDomId(presentation.workspace.id);
  return `<div id="${id}" class="fixed-workspace-presentation" data-controller="workspace-presentation" data-workspace-presentation-workspace-id-value="${escapeHtml(presentation.workspace.id)}" data-workspace-id="${escapeHtml(presentation.workspace.id)}" data-workspace-commands="${escapeHtml(JSON.stringify(presentation.commands ?? []))}">
    <div class="fixed-shell-main">${renderAgentPane(presentation)}${renderWorkPane(presentation)}</div>
    ${renderWorkspaceBar(presentation)}
    ${(presentation.overlayHtml ?? []).join("")}
  </div>`;
}

function behaviorTurboStream(action: string, workspaceId: string, attributes: Record<string, string | number | boolean | undefined> = {}): string {
  let data = "";
  for (const [name, value] of Object.entries({ "workspace-id": workspaceId, ...attributes })) {
    if (value !== undefined) data += ` data-${name}="${escapeHtml(String(value))}"`;
  }
  return `<turbo-stream action="${escapeHtml(action)}" target="workspace_detail"${data}></turbo-stream>`;
}

export function presentWorkViewTurboStream(workspaceId: string, key: string): string {
  return behaviorTurboStream("present-work-view", workspaceId, { "work-view-key": key });
}

export function selectAgentTurboStream(workspaceId: string, conversationId: string): string {
  return behaviorTurboStream("select-agent", workspaceId, { "conversation-id": conversationId });
}

export function selectAgentSuccessorTurboStream(workspaceId: string, closedConversationId: string, successorConversationId: string): string {
  return behaviorTurboStream("select-agent-successor", workspaceId, { "closed-conversation-id": closedConversationId, "successor-conversation-id": successorConversationId });
}

export function workspacePreparationInvalidatedTurboStream(workspaceId: string, conversationId?: string): string {
  return behaviorTurboStream("invalidate-workspace-preparation", workspaceId, { "conversation-id": conversationId });
}

export interface AgentTabsTurboStreamOptions {
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

export interface WorkViewsTurboStreamOptions {
  openedKey?: string;
  removedKey?: string;
  successorKey?: string;
  selectKey?: string;
  intendSelection?: boolean;
}

export function workViewsTurboStream(workspaceId: string, workViews: readonly WorkPaneContribution[], options: WorkViewsTurboStreamOptions = {}): string {
  const opened = options.openedKey === undefined ? undefined : workViews.find((view) => view.key === options.openedKey);
  if (options.openedKey !== undefined && !opened) throw new Error(`Opened Work view is missing from the presentation: ${options.openedKey}`);
  const mobileWorkViews = renderMobileWorkViews(workViews);
  const streams = [
    turboStream("update", workViewDomId(workspaceId, "selectors"), renderWorkViewSelectors(workspaceId, workViews)),
    turboStream("update", workViewDomId(workspaceId, "mobile_destinations"), mobileWorkViews.destinations),
    turboStream("update", workViewDomId(workspaceId, "mobile_overflow"), mobileWorkViews.overflowItems),
    turboStream("update", workViewDomId(workspaceId, "mobile_closers"), workViews.map(renderMobileWorkViewCloser).join("")),
    turboStream("update", workViewDomId(workspaceId, "mobile_more_attention"), mobileMoreAttentionHtml),
    ...workViews.flatMap((view) => [
      turboStream("update", workViewAvailabilityDomId(workspaceId, view.key), renderAvailability(view)),
      turboStream("update", workViewActionsDomId(workspaceId, view.key), view.actionsHtml ?? ""),
    ]),
  ];
  if (opened) {
    streams.push(turboStream("remove", workViewDomId(workspaceId, "empty")));
    streams.push(turboStream("append", workViewDomId(workspaceId, "bodies"), renderWorkViewPane(workspaceId, opened)));
  }
  if (options.removedKey) streams.push(turboStream("remove", workViewPaneDomId(workspaceId, options.removedKey)));
  if (workViews.length === 0) {
    streams.push(turboStream("append", workViewDomId(workspaceId, "bodies"), `<div id="${workViewDomId(workspaceId, "empty")}" class="fixed-shell-empty-work empty-state">Open Files, a file, terminal, or browser to work alongside the Agent.</div>`));
  } else {
    streams.push(turboStream("remove", workViewDomId(workspaceId, "empty")));
  }
  if (options.selectKey) {
    streams.push(options.intendSelection
      ? behaviorTurboStream("intend-work-view", workspaceId, { "work-view-key": options.selectKey })
      : presentWorkViewTurboStream(workspaceId, options.selectKey));
  }
  if (options.removedKey) {
    streams.push(behaviorTurboStream("select-work-view-successor", workspaceId, { "closed-work-view-key": options.removedKey, "successor-work-view-key": options.successorKey }));
  }
  streams.push(workspacePreparationInvalidatedTurboStream(workspaceId));
  return streams.join("");
}

export function openWorkViewTurboStream(workspaceId: string, workViews: readonly WorkPaneContribution[], openedKey: string): string {
  return workViewsTurboStream(workspaceId, workViews, { openedKey });
}

export function removeWorkspaceResidentTurboStream(workspaceId: string): string {
  return `<turbo-stream action="remove-workspace-resident" target="${escapeHtml(workspacePresentationDomId(workspaceId))}"></turbo-stream>`;
}

export function workspacePaneCollectionsTurboStream(presentation: WorkspacePanePresentation): string {
  const regions = renderWorkspacePaneCollectionRegions(presentation);
  return [
    turboStream("update", workspacePaneScrollDomId, regions.scrollHtml),
    turboStream("replace", workspaceProjectsDrawerDomId, regions.projectsDrawerHtml),
    turboStream("replace", atelierNextUnreadDomId, renderAtelierNextUnreadButton(presentation)),
    '<turbo-stream action="workspace-pane-changed" targets="[data-workspace-pane-collections]"></turbo-stream>',
  ].join("");
}
