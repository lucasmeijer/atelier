import { disclosureIconHtml, domId, escapeHtml, turboStream } from "@atelier/shared";
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
  kind: "resource" | "contextual";
  mobileDestination: "direct" | "more";
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

type IconName = "agent" | "atelier" | "browser" | "close" | "code" | "desktop" | "file" | "files" | "more" | "panel" | "park" | "plus" | "review" | "settings" | "terminal" | "trash" | "workspace" | "x";

function icon(name: IconName): string {
  const paths = {
    agent: '<path d="M9 4h6M12 4V2M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
    atelier: '<path d="M12 3v4M7.5 21 12 7l4.5 14M6 18h12M4 13c4 1.5 7.5 1.8 11 .8 2-.6 3.7-.6 5-.2"/>',
    browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    close: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    code: '<path d="m9 7-5 5 5 5m6-10 5 5-5 5"/>',
    desktop: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    file: '<path d="M7 3h7l4 4v14H7zM14 3v5h4"/>',
    files: '<path d="M4 5h6l2 2h8v12H4z"/>',
    panel: '<path d="M4 4h16v16H4zM15 4v16"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    park: '<path d="M17.5 15.5A7 7 0 0 1 8.5 6.5a7 7 0 1 0 9 9z"/><path d="M16 5h4M18 3v4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    review: '<path d="M9 5h6M9 3h6v4H9zM7 5H5v16h14V5h-2M8 13l2 2 5-5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
    terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    workspace: '<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  } as const;
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function topBarButton(label: string, action: string, iconName: Parameters<typeof icon>[0], attributes = ""): string {
  return `<button type="button" class="button secondary icon-only" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-action="${action}" ${attributes}>${icon(iconName)}</button>`;
}

function closeForm(close: ViewCloseAction, buttonHtml: string, attributes = ""): string {
  return `<form${attributes} data-turbo="true" method="post" action="${escapeHtml(close.action)}" data-close-label="${escapeHtml(close.label)}" data-action="submit->workspace-presentation#confirmClose">${buttonHtml}</form>`;
}

function actionItemLabel(text: string): string {
  return `<span class="action-item__label"><span class="action-item__label-text">${escapeHtml(text)}</span></span>`;
}

function selectorCloseButton(close: ViewCloseAction): string {
  return `<button class="fixed-shell-view-close action-item__action button danger icon-only" type="submit" title="Close ${escapeHtml(close.label)}" aria-label="Close ${escapeHtml(close.label)}">${icon("x")}</button>`;
}

function selectorCloseForm(close: ViewCloseAction): string {
  return closeForm(close, selectorCloseButton(close));
}

function renderWorkspaceRowStatus(workspace: WorkspacePaneEntry): string {
  if (workspace.state === "starting" || workspace.state === "deleting") {
    const label = workspace.state === "starting" ? "Workspace starting" : "Workspace deleting";
    return `<i class="status-spinner sm fixed-shell-workspace-busy action-item__status" aria-label="${label}" title="${label}"></i>`;
  }
  if (workspace.busyViewKeys?.length) {
    return '<i class="status-spinner sm fixed-shell-workspace-busy action-item__status" aria-label="Workspace busy" title="Workspace busy"></i>';
  }
  if (workspace.attention) {
    return '<span class="workspace-attention-status action-item__status" aria-label="Attention"><i class="status-dot attention at-edge" aria-hidden="true"></i></span>';
  }
  return workspace.outdated ? '<i class="fixed-shell-workspace-warning action-item__status" aria-label="Workspace created with an older version of Atelier" title="Some newer features may require a new workspace">⚠︎</i>' : "";
}

function renderWorkspaceRowContent(workspace: WorkspacePaneEntry): string {
  return `${actionItemLabel(workspace.title)}${renderWorkspaceRowStatus(workspace)}`;
}

function renderWorkspaceRow(workspace: WorkspacePaneEntry, projectId?: string): string {
  const attentionAt = workspace.attentionAt === undefined ? "" : ` data-workspace-attention-at="${workspace.attentionAt}"`;
  const attentionTokens = workspace.attentionTokens === undefined ? "" : ` data-workspace-attention-tokens="${escapeHtml(JSON.stringify(workspace.attentionTokens))}"`;
  const project = projectId ? ` data-project-id="${escapeHtml(projectId)}"` : "";
  const busyViews = workspace.busyViewKeys?.length ? ` data-workspace-busy-views="${escapeHtml(JSON.stringify(workspace.busyViewKeys))}"` : "";
  return `<button type="button" class="fixed-shell-workspace-row action-item action-item__primary${workspace.active ? " active" : ""}" title="${escapeHtml(workspace.title)}"${workspace.active ? ' aria-current="page"' : ""} data-workspace-entry-id="${escapeHtml(workspace.id)}"${attentionAt}${attentionTokens}${busyViews}${project} data-action="click->workspace-navigation#selectWorkspace">${renderWorkspaceRowContent(workspace)}</button>`;
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
  const heading = mode === "disclosure"
    ? `<button type="button" class="fixed-shell-project-heading action-item__primary" aria-expanded="${options.expanded ?? true}" data-action="click->workspace-navigation#toggleProject" data-project-id="${escapeHtml(id)}">${disclosureIconHtml}${actionItemLabel(title)}</button>`
    : mode === "launcher"
      ? `<a class="fixed-shell-project-heading action-item__primary" href="${escapeHtml(add.href)}" ${addTarget} aria-label="${escapeHtml(add.label)}">${actionItemLabel(title)}</a>`
      : `<span class="fixed-shell-project-heading fixed-shell-project-heading-static action-item__primary">${actionItemLabel(title)}</span>`;
  const settings = options.settingsHref ? `<a class="fixed-shell-project-settings action-item__action button secondary icon-only" href="${escapeHtml(options.settingsHref)}" ${projectEditorTarget} aria-label="Project settings: ${escapedTitle}" title="Project settings: ${escapedTitle}">${icon("more")}</a>` : "";
  const onboardingClass = options.onboardingDestination ? " is-onboarding-target" : "";
  const onboardingAttribute = options.onboardingDestination ? ` data-empty-workspace-onboarding-destination="${options.onboardingDestination}"` : "";
  const actions = `<span class="fixed-shell-project-actions button-group">${settings}<a class="fixed-shell-project-add action-item__action button secondary icon-only${onboardingClass}"${onboardingAttribute} href="${escapeHtml(add.href)}" ${addTarget} aria-label="${escapeHtml(add.label)}" title="${escapeHtml(add.label)}">${icon("plus")}</a></span>`;
  return `<div class="fixed-shell-project-heading-row action-item">${heading}${actions}</div>`;
}

function renderProjectHeading(project: Pick<WorkspacePaneProject, "id" | "title">, mode: "disclosure" | "launcher" = "disclosure", onboardingDestination?: Exclude<WorkspacePaneOnboardingState, "workspaces">): string {
  const id = encodeURIComponent(project.id);
  return renderWorkspaceGroupHeading(project.id, project.title, { href: `/projects/${id}/launch-composer`, frame: "launch_composer", label: `New workspace: ${project.title}` }, { mode, settingsHref: `/projects/${id}/editor`, onboardingDestination });
}

function renderParkedWorkspaceGroup(workspaces: readonly WorkspacePaneEntry[], parentId: string): string {
  if (workspaces.length === 0) return "";
  const groupId = `${parentId}:parked`;
  return `<section class="fixed-shell-project action-list fixed-shell-parked is-collapsed" data-project-id="${escapeHtml(groupId)}">
    <div class="fixed-shell-project-heading-row action-item"><button type="button" class="fixed-shell-project-heading action-item__primary" aria-expanded="false" data-action="click->workspace-navigation#toggleProject" data-project-id="${escapeHtml(groupId)}">${disclosureIconHtml}${actionItemLabel(`${workspaces.length} parked`)}</button></div>
    <div class="fixed-shell-project-workspaces action-list">${workspaces.map((workspace) => `<form method="post" action="/workspaces/${encodeURIComponent(workspace.id)}/unpark" data-workspace-entry-id="${escapeHtml(workspace.id)}" data-action="submit->workspace-navigation#unparkWorkspace"><button type="submit" class="fixed-shell-workspace-row action-item action-item__primary" title="Unpark and open ${escapeHtml(workspace.title)}" aria-label="Unpark and open ${escapeHtml(workspace.title)}">${renderWorkspaceRowContent(workspace)}</button></form>`).join("")}</div>
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

export function renderWorkspacePaneCollections(presentation: WorkspacePanePresentation, sidebarContributionsHtml = ""): string {
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
  const settings = `<a class="button secondary icon-only" href="/settings" title="Settings" aria-label="Settings" data-controller="settings-prefetch" data-action="pointerenter->settings-prefetch#prefetch focus->settings-prefetch#prefetch click->settings-prefetch#open">${icon("settings")}</a>`;
  return `<aside class="fixed-shell-workspace-pane" aria-label="Workspaces">
    <header><strong>${icon("atelier")}Atelier</strong><div class="button-group">${settings}${topBarButton("Collapse Workspace pane", "click->workspace-navigation#toggleDesktopWorkspacePane", "panel", "data-collapse-workspace-pane")}</div></header>
    ${renderWorkspacePaneCollections(presentation, sidebarContributionsHtml)}
  </aside>`;
}

const mobileActionItemClasses = "action-item action-item__primary";

export function renderGlobalMobileNavigation(): string {
  return `<nav class="fixed-shell-mobile-nav fixed-shell-global-mobile-nav button-group" aria-label="Application destinations">
    <button class="fixed-shell-mobile-fixed ${mobileActionItemClasses}" type="button" aria-label="Workspace" title="Workspace" aria-expanded="false" data-mobile-workspace-destination data-action="click->workspace-navigation#toggleWorkspacePane">${icon("workspace")}</button>
  </nav>`;
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
  return `<div id="${agentTabDomId(workspaceId, agent.id)}" class="fixed-shell-agent-conversation action-item"><button class="action-item__primary" type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-conversation-id="${escapeHtml(agent.id)}" data-action="click->workspace-presentation#selectAgent"><span class="fixed-shell-agent-icon">${icon("agent")}</span>${actionItemLabel(agent.title)}</button>${agent.close ? selectorCloseForm(agent.close) : ""}</div>`;
}

function renderAgentNavigation(presentation: WorkspacePresentation): string {
  const multiple = presentation.agentConversations.length > 1;
  return multiple
    ? `<div id="${agentTabListDomId(presentation.workspace.id)}" class="fixed-shell-agent-conversations" role="tablist" aria-label="Agent conversations">${presentation.agentConversations.map((agent) => renderAgentTab(presentation.workspace.id, agent)).join("")}</div>`
    : `<div class="fixed-shell-workspace-title"><span class="fixed-shell-agent-icon">${icon("agent")}</span><strong>${escapeHtml(presentation.workspace.title)}</strong></div>`;
}

function renderAgentPaneSlot(workspaceId: string, agent: AgentPaneContribution): string {
  const loading = `<div class="agent-body-loading" role="status" aria-label="Loading ${escapeHtml(agent.title)}"><span class="status-spinner" aria-hidden="true"></span></div>`;
  const frame = `<turbo-frame id="${agentBodyFrameId(workspaceId, agent.id)}" src="${escapeHtml(agent.bodyUrl)}" loading="lazy" data-agent-body-hydration data-action="turbo:frame-load->workspace-presentation#agentBodyLoaded">${loading}</turbo-frame>`;
  return `<section id="${agentPaneSlotDomId(workspaceId, agent.id)}" class="fixed-shell-surface" data-workspace-pane-role="agent" data-workspace-pane-id="${escapeHtml(agent.id)}" data-workspace-logically-visible="false" tabindex="-1"><div class="fixed-shell-live-body">${frame}</div></section>`;
}

function renderAgentActions(presentation: WorkspacePresentation): string {
  const agentActions = (presentation.commands ?? []).filter((command) => command.placement === "agent-action").map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button class="button secondary icon-only" type="submit" title="${escapeHtml(command.label)}" aria-label="${escapeHtml(command.label)}">${icon("plus")}</button></form>`).join("");
  const parkWorkspace = `<form class="fixed-shell-park-workspace" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/park" data-action="submit->workspace-navigation#parkWorkspace"><button class="button secondary icon-only" type="submit" title="Park workspace" aria-label="Park workspace">${icon("park")}</button></form>`;
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete"><button class="button danger icon-only" type="submit" title="Delete workspace" aria-label="Delete workspace">${icon("trash")}</button></form>`;
  return `${agentActions}${parkWorkspace}${deleteWorkspace}${topBarButton("Show Work pane", "click->workspace-presentation#toggleWorkPane", "panel", "data-show-work-pane")}`;
}

function renderAgentPane(presentation: WorkspacePresentation): string {
  const panes = presentation.agentConversations.map((agent) => renderAgentPaneSlot(presentation.workspace.id, agent)).join("");
  return `<section class="fixed-shell-agent-pane" data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent">
    <header>${topBarButton("Show Workspace pane", "click->workspace-navigation#toggleDesktopWorkspacePane", "panel", "data-show-workspace-pane")}<div id="${agentNavigationDomId(presentation.workspace.id)}">${renderAgentNavigation(presentation)}</div><div id="${agentActionsDomId(presentation.workspace.id)}" class="fixed-shell-agent-actions button-group">${renderAgentActions(presentation)}</div></header>
    <div id="${agentBodiesDomId(presentation.workspace.id)}" class="fixed-shell-agent-bodies">${panes}</div>
  </section>`;
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
  const iconName = workViewTypeIcon(view.key.slice(0, view.key.indexOf(":")));
  return `<div id="${workViewSelectorDomId(workspaceId, view.key)}" class="fixed-shell-work-view-selector action-item" draggable="true" data-work-view-reorder-key="${escapeHtml(view.key)}" data-action="dragstart->workspace-presentation#beginWorkReorder dragover->workspace-presentation#allowWorkReorder drop->workspace-presentation#finishWorkReorder">
    <button class="action-item__primary" type="button" role="tab" aria-selected="false" tabindex="-1" data-work-view-key="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}"${view.attentionSequence === undefined ? "" : ` data-attention-sequence="${view.attentionSequence}"`} data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="${escapeHtml(view.sourceKey ?? view.key)}" data-atelier-fullscreen-title-value="${escapeHtml(view.label)}" data-action="click->workspace-presentation#selectWorkView"><span class="fixed-shell-work-view-icon" data-icon="${iconName}">${icon(iconName)}</span>${actionItemLabel(view.label)}${view.attentionSequence === undefined ? "" : '<i class="status-dot attention action-item__status" aria-label="Attention"></i>'}</button>${view.close ? selectorCloseForm(view.close) : ""}
  </div>`;
}

function renderWorkViewSelectors(workspaceId: string, views: readonly WorkPaneContribution[]): string {
  return views.map((view) => renderWorkViewSelector(workspaceId, view)).join("");
}

function renderWorkViewPane(workspaceId: string, view: WorkPaneContribution): string {
  const body = view.bodyHtml ?? (view.bodyUrl
    ? `<turbo-frame id="${workViewBodyFrameId(workspaceId, view.key)}" src="${escapeHtml(view.bodyUrl)}" loading="lazy" data-work-view-hydration data-action="turbo:before-frame-render->workspace-presentation#workBodyWillRender turbo:frame-load->workspace-presentation#workBodyLoaded"><div class="work-view-hydration-loading" role="status" aria-label="Loading ${escapeHtml(view.label)}"><span class="status-spinner" aria-hidden="true"></span></div></turbo-frame>`
    : "");
  const source = view.sourceKey ? ` data-source-work-view-key="${escapeHtml(view.sourceKey)}"` : "";
  return `<section id="${workViewPaneDomId(workspaceId, view.key)}" class="fixed-shell-surface" data-workspace-pane-role="work" data-workspace-pane-id="${escapeHtml(view.key)}" data-workspace-logically-visible="false"${source} tabindex="-1"><div id="${workViewAvailabilityDomId(workspaceId, view.key)}">${renderAvailability(view)}</div><div id="${workViewActionsDomId(workspaceId, view.key)}" class="fixed-shell-work-actions">${view.actionsHtml ?? ""}</div><div class="fixed-shell-live-body">${body}</div></section>`;
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

function workViewTypeIcon(type: string): IconName {
  switch (type) {
    case "browser": return "browser";
    case "desktop": return "desktop";
    case "files": return "files";
    case "review": return "review";
    case "terminal": return "terminal";
    case "vscode": return "code";
    default: return "plus";
  }
}

function workLauncherIcon(commandId: string): IconName {
  return workViewTypeIcon(commandId.slice(0, commandId.indexOf(".")));
}

function renderWorkLauncherCommand(command: NonNullable<WorkspacePresentation["commands"]>[number], workspaceId: string): string {
  return `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(command.id)}"><button class="action-item action-item__primary" type="submit" role="menuitem"><span class="popup-menu__icon">${icon(workLauncherIcon(command.id))}</span>${actionItemLabel(command.label)}</button></form>`;
}

function renderWorkPane(presentation: WorkspacePresentation): string {
  const selectors = renderWorkViewSelectors(presentation.workspace.id, presentation.workViews);
  const panes = presentation.workViews.map((view) => renderWorkViewPane(presentation.workspace.id, view)).join("");
  const workCommands = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher");
  const addMenuId = workViewDomId(presentation.workspace.id, "add_menu");
  const addMenu = workCommands.length ? `<span class="popup-menu-anchor"><button class="button primary icon-only popup-menu-trigger" type="button" title="Open Work view" aria-label="Open Work view" aria-haspopup="menu" aria-controls="${addMenuId}" popovertarget="${addMenuId}">${icon("plus")}</button><div class="popup-menu action-list popup-menu-anchored" id="${addMenuId}" role="menu" aria-label="Open Work view" popover="auto">${workCommands.map((command) => renderWorkLauncherCommand(command, presentation.workspace.id)).join("")}</div></span>` : "";
  return `<section class="fixed-shell-work-pane" data-workspace-role-region="work" data-workspace-presentation-target="workPane" aria-label="Work">
    <header class="work-view-toolbar"><div id="${workViewDomId(presentation.workspace.id, "selectors")}" class="fixed-shell-work-view-selectors" role="tablist" aria-label="Work views">${selectors}</div><span id="${workViewDomId(presentation.workspace.id, "launchers")}">${addMenu}</span>${topBarButton("Collapse Work pane", "click->workspace-presentation#toggleWorkPane", "panel", "data-collapse-work-pane")}</header>
    <div id="${workViewDomId(presentation.workspace.id, "bodies")}" class="fixed-shell-work-bodies">${panes || `<div id="${workViewDomId(presentation.workspace.id, "empty")}" class="fixed-shell-empty-work empty-state">Open Files, a file, terminal, or browser to work alongside the Agent.</div>`}</div>
    <div class="fixed-shell-work-resizer" role="separator" aria-label="Resize Work pane" aria-orientation="vertical" tabindex="0" data-action="pointerdown->workspace-presentation#beginWorkResize keydown->workspace-presentation#resizeWorkWithKeyboard"></div>
  </section>`;
}

function mobileWorkIcon(view: WorkPaneContribution): IconName {
  if (view.key.startsWith("browser:")) return "browser";
  if (view.key.startsWith("terminal:")) return "terminal";
  return "file";
}

function renderMobileDestination(label: string, destination: string, iconName: IconName, attention = false): string {
  const escapedLabel = escapeHtml(label);
  const attentionHtml = attention ? '<i class="status-dot attention" aria-label="Attention"></i>' : "";
  return `<button class="${mobileActionItemClasses}" type="button" aria-label="${escapedLabel}" title="${escapedLabel}" data-mobile-destination="${escapeHtml(destination)}" data-action="click->workspace-presentation#selectMobileDestination">${icon(iconName)}${attentionHtml}</button>`;
}

function renderMobileDirectWorkViews(views: readonly WorkPaneContribution[]): string {
  return views.filter((view) => view.mobileDestination === "direct").map((view) => renderMobileDestination(view.label, `work:${view.key}`, mobileWorkIcon(view), view.attentionSequence !== undefined)).join("");
}

function renderMobileSecondaryWorkViews(views: readonly WorkPaneContribution[]): string {
  return views.filter((view) => view.mobileDestination === "more").map((view) => `<button type="button" data-more-work-key="${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMoreWorkView">${escapeHtml(view.label)}${view.attentionSequence === undefined ? "" : '<i class="status-dot attention at-edge" aria-label="Attention"></i>'}</button>`).join("") || "<p>No secondary views are available.</p>";
}

function renderMobileCloser(destination: string, close: ViewCloseAction): string {
  return `<div data-more-close-destination="${escapeHtml(destination)}" hidden>${closeForm(close, '<button class="fixed-shell-more-close-current" type="submit">Close current view</button>')}</div>`;
}

function renderMobileWorkViewCloser(view: WorkPaneContribution): string {
  return view.close ? renderMobileCloser(`work:${view.key}`, view.close) : "";
}

function renderMobileNavigation(presentation: WorkspacePresentation): string {
  const agentsDestination = renderMobileDestination("Agents", "agents", "agent");
  const direct = renderMobileDirectWorkViews(presentation.workViews);
  const openSecondary = renderMobileSecondaryWorkViews(presentation.workViews);
  const launcherCommands = new Set(["files.create", "terminal.create", "terminal.attach", "browser.create", "vscode.open", "desktop.open"]);
  const launchers = (presentation.commands ?? []).filter((command) => launcherCommands.has(command.id)).map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.label)}</button></form>`).join("");
  const closers = presentation.workViews.map(renderMobileWorkViewCloser).join("");
  const hiddenAttention = presentation.workViews.some((view) => view.mobileDestination === "more" && view.attentionSequence !== undefined);
  return `<nav class="fixed-shell-mobile-nav fixed-shell-resident-mobile-nav button-group" aria-label="Current workspace destinations">
    <div class="fixed-shell-mobile-scroll button-group">${agentsDestination}<span id="${workViewDomId(presentation.workspace.id, "mobile_direct")}" class="fixed-shell-mobile-work-items button-group">${direct}</span></div>
    <button class="fixed-shell-mobile-fixed ${mobileActionItemClasses}" type="button" aria-label="More" title="More" data-mobile-more data-action="click->workspace-presentation#toggleMore">${icon("more")}<span id="${workViewDomId(presentation.workspace.id, "mobile_more_attention")}">${hiddenAttention ? '<i class="status-dot attention" aria-label="Hidden Attention"></i>' : ""}</span></button>
    <section class="fixed-shell-more-menu" data-workspace-presentation-target="moreMenu" aria-label="More" hidden>
      <header><button type="button" class="fixed-shell-more-close" aria-label="Close More" data-action="click->workspace-presentation#toggleMore">${icon("close")}</button></header>
      <div class="fixed-shell-more-section"><span id="${workViewDomId(presentation.workspace.id, "mobile_secondary")}" class="fixed-shell-mobile-work-items">${openSecondary}</span></div>
      <div class="fixed-shell-more-section"><h2>Open or create</h2>${launchers}</div>
      <div id="${workViewDomId(presentation.workspace.id, "mobile_closers")}" class="fixed-shell-more-section fixed-shell-more-close-section">${closers}</div>
    </section>
  </nav>`;
}

function renderDeletionIssues(deletion: Extract<WorkspaceDeletionState, { status: "blocked" }>): string {
  return deletion.issues.map((issue) => `<section class="workspace-deletion-issue">
    ${issue.uncommittedPaths.length > 0 ? `<section class="workspace-deletion-change-group"><h2>Uncommitted changes</h2><ul>${issue.uncommittedPaths.map((path) => `<li>${escapeHtml(path)}</li>`).join("")}</ul></section>` : ""}
    ${issue.outgoingCommits.length > 0 ? `<section class="workspace-deletion-change-group"><h2>Unpushed commits</h2><ul>${issue.outgoingCommits.map((commit) => `<li><span class="workspace-deletion-hash">${escapeHtml(commit.hash.slice(0, 12))}</span><span>${escapeHtml(commit.subject)}</span></li>`).join("")}</ul></section>` : ""}
  </section>`).join("");
}

export function renderWorkspaceDeletionPresentation(workspaceId: string, deletion: WorkspaceDeletionState): string {
  const id = encodeURIComponent(workspaceId);
  let content: string;
  if (deletion.status === "checking") {
    content = '<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>Checking if it’s safe to delete…</h1><p>Atelier is checking for uncommitted changes and unpushed commits.</p></div>';
  } else if (deletion.status === "deleting") {
    const title = deletion.forced ? "Force deleting workspace…" : "Deleting workspace…";
    const detail = deletion.forced ? "Local changes or unpushed commits may be discarded." : "The safety check passed. Atelier is removing the workspace.";
    content = `<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>${title}</h1><p>${detail}</p></div>`;
  } else if (deletion.status === "blocked") {
    content = `<header class="workspace-deletion-heading"><h1>Please confirm it's okay to delete the workspace with these outstanding changes.</h1></header><div class="workspace-deletion-issues" aria-label="Outstanding workspace changes">${renderDeletionIssues(deletion)}</div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true"><button class="button secondary" type="submit">Cancel deletion</button></form><form method="post" action="/workspaces/${id}/delete?force=1" data-turbo="true"><button class="button danger" type="submit">Delete anyway</button></form></footer>`;
  } else {
    content = `<div class="workspace-deletion-heading"><h1>Workspace deletion failed</h1><p class="workspace-deletion-error">${escapeHtml(deletion.error)}</p></div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true"><button class="button secondary" type="submit">Cancel deletion</button></form><form method="post" action="/workspaces/${id}/delete/retry" data-turbo="true"><button class="button danger" type="submit">Retry deletion</button></form></footer>`;
  }
  return `<div id="${domId("fixed_workspace", workspaceId)}" class="fixed-workspace-presentation workspace-deletion-presentation" data-workspace-id="${escapeHtml(workspaceId)}"><main class="workspace-deletion-state" data-deletion-status="${deletion.status}" role="${deletion.status === "failed" ? "alert" : "status"}">${content}</main></div>`;
}

export function renderWorkspacePresentation(presentation: WorkspacePresentation): string {
  if (presentation.agentConversations.length === 0) throw new Error("Workspace presentation requires an Agent conversation");
  const id = workspacePresentationDomId(presentation.workspace.id);
  return `<div id="${id}" class="fixed-workspace-presentation" data-controller="workspace-presentation" data-workspace-presentation-workspace-id-value="${escapeHtml(presentation.workspace.id)}" data-workspace-id="${escapeHtml(presentation.workspace.id)}" data-workspace-commands="${escapeHtml(JSON.stringify(presentation.commands ?? []))}">
    <div class="fixed-shell-main">${renderAgentPane(presentation)}${renderWorkPane(presentation)}</div>
    ${renderMobileNavigation(presentation)}
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

function renderMobileMoreAttention(views: readonly WorkPaneContribution[]): string {
  return views.some((view) => view.mobileDestination === "more" && view.attentionSequence !== undefined)
    ? '<i class="status-dot attention" aria-label="Hidden Attention"></i>'
    : "";
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
  const streams = [
    turboStream("update", workViewDomId(workspaceId, "selectors"), renderWorkViewSelectors(workspaceId, workViews)),
    turboStream("update", workViewDomId(workspaceId, "mobile_direct"), renderMobileDirectWorkViews(workViews)),
    turboStream("update", workViewDomId(workspaceId, "mobile_secondary"), renderMobileSecondaryWorkViews(workViews)),
    turboStream("update", workViewDomId(workspaceId, "mobile_closers"), workViews.map(renderMobileWorkViewCloser).join("")),
    turboStream("update", workViewDomId(workspaceId, "mobile_more_attention"), renderMobileMoreAttention(workViews)),
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
    '<turbo-stream action="workspace-pane-changed" targets="[data-workspace-pane-collections]"></turbo-stream>',
  ].join("");
}
