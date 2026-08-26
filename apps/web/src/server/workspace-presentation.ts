import { disclosureIconHtml, domId, escapeHtml, turboStream } from "@atelier/shared";
import type { WorkspaceDeletionState } from "./workspace-registry.ts";

export type WorkViewAvailability =
  | { phase: "opening"; detail?: string }
  | { phase: "live" }
  | { phase: "reconnecting"; detail?: string }
  | { phase: "unavailable"; detail: string; recoveryHtml?: string };

export interface WorkspacePaneEntry {
  id: string;
  title: string;
  active?: boolean;
  busy?: boolean;
  unreadAt?: number;
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
  bodyHtml: string;
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
  bodyHtml: string;
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
  /** Live nodes named here are transplanted from the current DOM by the Turbo seam. */
  preserveLiveKeys?: ReadonlySet<string>;
}

type IconName = "agent" | "browser" | "close" | "file" | "more" | "panel" | "park" | "plus" | "terminal" | "trash" | "workspace" | "x";

function icon(name: IconName): string {
  const paths = {
    agent: '<path d="M9 4h6M12 4V2M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
    browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    close: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    file: '<path d="M7 3h7l4 4v14H7zM14 3v5h4"/>',
    panel: '<path d="M4 4h16v16H4zM15 4v16"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    park: '<path d="M17.5 15.5A7 7 0 0 1 8.5 6.5a7 7 0 1 0 9 9z"/><path d="M16 5h4M18 3v4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    workspace: '<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  } as const;
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
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

function workViewCloseForm(close: ViewCloseAction): string {
  return closeForm(close, selectorCloseButton(close), ' class="fixed-shell-work-view-close" hidden');
}

function renderWorkspaceRowStatus(workspace: WorkspacePaneEntry): string {
  if (workspace.busy) return '<i class="status-spinner sm fixed-shell-workspace-busy action-item__status" aria-label="Workspace busy" title="Workspace busy"></i>';
  if (workspace.unreadAt !== undefined && !workspace.active) return '<i class="fixed-shell-attention-dot action-item__status" aria-label="Agent ready"></i>';
  if (workspace.outdated) return '<i class="fixed-shell-workspace-warning action-item__status" aria-label="Workspace created with an older version of Atelier" title="Some newer features may require a new workspace">⚠︎</i>';
  return "";
}

function renderWorkspaceRowContent(workspace: WorkspacePaneEntry): string {
  return `${actionItemLabel(workspace.title)}${renderWorkspaceRowStatus(workspace)}`;
}

function renderWorkspaceRow(workspace: WorkspacePaneEntry, projectId?: string): string {
  const unreadAt = workspace.unreadAt === undefined ? "" : ` data-workspace-unread-at="${workspace.unreadAt}"`;
  const project = projectId ? ` data-project-id="${escapeHtml(projectId)}"` : "";
  return `<button type="button" class="fixed-shell-workspace-row action-item action-item__primary${workspace.active ? " active" : ""}" title="${escapeHtml(workspace.title)}"${workspace.active ? ' aria-current="page"' : ""} data-workspace-entry-id="${escapeHtml(workspace.id)}"${unreadAt}${project} data-action="click->workspace-navigation#selectWorkspace">${renderWorkspaceRowContent(workspace)}</button>`;
}

const projectlessWorkspaceGroupId = "__projectless__";
const projectsDrawerGroupId = "__projects_drawer__";

interface WorkspaceGroupAddAction {
  href: string;
  frame: "agent_launch_modal" | "project_editor_frame";
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
  const addTarget = add.frame === "project_editor_frame" ? projectEditorTarget : 'data-turbo-frame="agent_launch_modal"';
  const heading = mode === "disclosure"
    ? `<button type="button" class="fixed-shell-project-heading action-item__primary" aria-expanded="${options.expanded ?? true}" data-action="click->workspace-navigation#toggleProject" data-project-id="${escapeHtml(id)}">${disclosureIconHtml}${actionItemLabel(title)}</button>`
    : mode === "launcher"
      ? `<a class="fixed-shell-project-heading fixed-shell-project-launch action-item__primary" href="${escapeHtml(add.href)}" ${addTarget} aria-label="${escapeHtml(add.label)}">${actionItemLabel(title)}</a>`
      : `<span class="fixed-shell-project-heading fixed-shell-project-heading-static action-item__primary">${actionItemLabel(title)}</span>`;
  const settings = options.settingsHref ? `<a class="fixed-shell-project-action fixed-shell-project-settings action-item__action button secondary icon-only" href="${escapeHtml(options.settingsHref)}" ${projectEditorTarget} aria-label="Project settings: ${escapedTitle}" title="Project settings: ${escapedTitle}">${icon("more")}</a>` : "";
  const onboardingClass = options.onboardingDestination ? " is-onboarding-target" : "";
  const onboardingAttribute = options.onboardingDestination ? ` data-empty-workspace-onboarding-destination="${options.onboardingDestination}"` : "";
  return `<div class="fixed-shell-project-heading-row fixed-shell-navigation-action action-item${mode === "launcher" ? " fixed-shell-project-launch-row" : ""}">${heading}${settings}<a class="fixed-shell-project-action fixed-shell-project-add action-item__action button secondary icon-only${onboardingClass}"${onboardingAttribute} href="${escapeHtml(add.href)}" ${addTarget} aria-label="${escapeHtml(add.label)}" title="${escapeHtml(add.label)}">${icon("plus")}</a></div>`;
}

function renderProjectHeading(project: Pick<WorkspacePaneProject, "id" | "title">, mode: "disclosure" | "launcher" = "disclosure", onboardingDestination?: Exclude<WorkspacePaneOnboardingState, "workspaces">): string {
  const id = encodeURIComponent(project.id);
  return renderWorkspaceGroupHeading(project.id, project.title, { href: `/projects/${id}/agent-launch`, frame: "agent_launch_modal", label: `New workspace: ${project.title}` }, { mode, settingsHref: `/projects/${id}/editor`, onboardingDestination });
}

function renderParkedWorkspaceGroup(workspaces: readonly WorkspacePaneEntry[], parentId: string): string {
  if (workspaces.length === 0) return "";
  const groupId = `${parentId}:parked`;
  return `<section class="fixed-shell-project fixed-shell-parked is-collapsed" data-project-id="${escapeHtml(groupId)}">
    <div class="fixed-shell-project-heading-row fixed-shell-navigation-action action-item"><button type="button" class="fixed-shell-project-heading action-item__primary" aria-expanded="false" data-action="click->workspace-navigation#toggleProject" data-project-id="${escapeHtml(groupId)}">${disclosureIconHtml}${actionItemLabel(`${workspaces.length} parked`)}</button></div>
    <div class="fixed-shell-project-workspaces">${workspaces.map((workspace) => `<form method="post" action="/workspaces/${encodeURIComponent(workspace.id)}/unpark" data-workspace-entry-id="${escapeHtml(workspace.id)}" data-action="submit->workspace-navigation#unparkWorkspace"><button type="submit" class="fixed-shell-workspace-row action-item action-item__primary" title="Unpark and open ${escapeHtml(workspace.title)}" aria-label="Unpark and open ${escapeHtml(workspace.title)}">${renderWorkspaceRowContent(workspace)}</button></form>`).join("")}</div>
  </section>`;
}

export function renderWorkspacePaneCollections(presentation: WorkspacePanePresentation, sidebarContributionsHtml = ""): string {
  const projects = presentation.projects.map((project) => `<section class="fixed-shell-project" data-project-id="${escapeHtml(project.id)}">
    ${renderProjectHeading(project)}
    <div class="fixed-shell-project-workspaces">${project.workspaces.map((workspace) => renderWorkspaceRow(workspace, project.id)).join("")}${renderParkedWorkspaceGroup(project.parkedWorkspaces ?? [], project.id)}</div>
  </section>`).join("");
  const projectlessWorkspaces = presentation.projectlessWorkspaces ?? [];
  const projectlessParkedWorkspaces = presentation.projectlessParkedWorkspaces ?? [];
  const projectlessAdd = { href: "/agent-launch", frame: "agent_launch_modal", label: "New projectless workspace" } as const;
  const projectless = `<section class="fixed-shell-project" data-project-id="${projectlessWorkspaceGroupId}">
    ${renderWorkspaceGroupHeading(projectlessWorkspaceGroupId, "Projectless", projectlessAdd, { mode: projectlessWorkspaces.length > 0 || projectlessParkedWorkspaces.length > 0 ? "disclosure" : "static" })}
    ${projectlessWorkspaces.length > 0 || projectlessParkedWorkspaces.length > 0 ? `<div class="fixed-shell-project-workspaces">${projectlessWorkspaces.map((workspace) => renderWorkspaceRow(workspace)).join("")}${renderParkedWorkspaceGroup(projectlessParkedWorkspaces, projectlessWorkspaceGroupId)}</div>` : ""}
  </section>`;
  const drawerProjects = [...presentation.projects, ...(presentation.emptyProjects ?? [])].sort((left, right) => left.title.localeCompare(right.title));
  const onboardingState = workspacePaneOnboardingState(presentation);
  const needsFirstProject = onboardingState === "first-project";
  const needsFirstWorkspace = onboardingState === "first-workspace";
  const projectsDrawer = `<section class="fixed-shell-project fixed-shell-projects-drawer${needsFirstWorkspace ? "" : " is-collapsed"}" data-project-id="${projectsDrawerGroupId}">
    ${renderWorkspaceGroupHeading(projectsDrawerGroupId, "Projects", { href: "/projects/new/editor", frame: "project_editor_frame", label: "New project" }, { expanded: needsFirstWorkspace, onboardingDestination: needsFirstProject ? "first-project" : undefined })}
    <div class="fixed-shell-project-workspaces">${drawerProjects.map((project, index) => `<section class="fixed-shell-project">${renderProjectHeading(project, "launcher", needsFirstWorkspace && index === 0 ? "first-workspace" : undefined)}</section>`).join("")}</div>
  </section>`;
  return `<div class="fixed-shell-pane-collections" data-workspace-pane-collections>
    <div class="fixed-shell-workspace-scroll" data-workspace-navigation-target="scroll">${projects}${projectless}</div>
    <section id="global_sidebar_contributions">${sidebarContributionsHtml}</section>
    ${projectsDrawer}
  </div>`;
}

export function renderWorkspacePane(presentation: WorkspacePanePresentation, sidebarContributionsHtml = ""): string {
  return `<aside class="fixed-shell-workspace-pane" aria-label="Workspaces">
    ${renderWorkspacePaneCollections(presentation, sidebarContributionsHtml)}
    <footer><a class="fixed-shell-navigation-action action-item action-item__primary" href="/settings" data-turbo-frame="_top" data-turbo-stream="true">${actionItemLabel("Settings")}</a></footer>
  </aside>`;
}

export function renderEmptyWorkspaceMobileNavigation(): string {
  return `<nav class="fixed-shell-mobile-nav fixed-shell-empty-mobile-nav" aria-label="Workspace destinations">
    <button class="fixed-shell-mobile-fixed" type="button" aria-label="Workspace" title="Workspace" data-empty-workspace-mobile-destination data-action="click->workspace-navigation#showWorkspacePane">${icon("workspace")}</button>
  </nav>`;
}

function renderAgentPane(presentation: WorkspacePresentation): string {
  const multiple = presentation.agentConversations.length > 1;
  const title = multiple
    ? `<div class="fixed-shell-agent-conversations" role="tablist" aria-label="Agent conversations">${presentation.agentConversations.map((agent) => `<div class="fixed-shell-agent-conversation action-item"><button class="action-item__primary" type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-conversation-id="${escapeHtml(agent.id)}" data-action="click->workspace-presentation#selectAgent">${actionItemLabel(agent.title)}</button>${agent.close ? selectorCloseForm(agent.close) : ""}</div>`).join("")}</div>`
    : `<div class="fixed-shell-workspace-title"><strong>${escapeHtml(presentation.workspace.title)}</strong></div>`;
  const panes = presentation.agentConversations.map((agent) => renderLiveNode(`agent:${agent.id}`, "agent", agent.id, agent.bodyHtml, presentation.preserveLiveKeys)).join("");
  const agentActions = (presentation.commands ?? []).filter((command) => command.placement === "agent-action").map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button class="button secondary icon-only" type="submit" title="${escapeHtml(command.label)}" aria-label="${escapeHtml(command.label)}">${icon("plus")}</button></form>`).join("");
  const parkWorkspace = `<form class="fixed-shell-park-workspace" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/park" data-action="submit->workspace-navigation#parkWorkspace"><button class="button secondary icon-only" type="submit" title="Park workspace" aria-label="Park workspace">${icon("park")}</button></form>`;
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete"><button class="button danger icon-only" type="submit" title="Delete workspace" aria-label="Delete workspace">${icon("trash")}</button></form>`;
  return `<section class="fixed-shell-agent-pane" data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent">
    <header>${title}${agentActions}${parkWorkspace}${deleteWorkspace}${topBarButton("Show Work pane", "click->workspace-presentation#toggleWorkPane", "panel", "data-show-work-pane")}</header>
    <div class="fixed-shell-agent-bodies">${panes}</div>
  </section>`;
}

function renderAvailability(view: WorkPaneContribution): string {
  const { availability } = view;
  if (availability.phase === "live") return "";
  const label = availability.phase === "opening" ? "Opening" : availability.phase === "reconnecting" ? "Reconnecting" : "Unavailable";
  const detail = availability.detail ?? (availability.phase === "opening" ? `Opening ${view.label}…` : `Reconnecting ${view.label}…`);
  return `<div class="fixed-shell-availability fixed-shell-availability-${availability.phase}" role="${availability.phase === "unavailable" ? "alert" : "status"}">
    <span class="fixed-shell-availability-mark" aria-hidden="true"></span><strong>${label}</strong><p>${escapeHtml(detail)}</p>${availability.phase === "unavailable" ? availability.recoveryHtml ?? "" : ""}
  </div>`;
}

function renderLiveNode(key: string, role: "agent" | "work", id: string, bodyHtml: string, preserved?: ReadonlySet<string>, workView?: WorkPaneContribution): string {
  if (preserved?.has(key)) return `<span hidden data-workspace-live-slot="${escapeHtml(key)}"></span>`;
  return `<section class="fixed-shell-live-node" data-workspace-live-node="${escapeHtml(key)}" data-workspace-pane-role="${role}" data-workspace-pane-id="${escapeHtml(id)}"${workView?.sourceKey ? ` data-source-work-view-key="${escapeHtml(workView.sourceKey)}"` : ""} tabindex="-1">${workView ? renderAvailability(workView) : ""}<div class="fixed-shell-live-body">${bodyHtml}</div></section>`;
}

function renderWorkViewSelector(view: WorkPaneContribution): string {
  return `<div class="fixed-shell-work-view-selector action-item" draggable="true" data-work-view-reorder-key="${escapeHtml(view.key)}" data-action="dragstart->workspace-presentation#beginWorkReorder dragover->workspace-presentation#allowWorkReorder drop->workspace-presentation#finishWorkReorder">
    <button class="action-item__primary" type="button" role="tab" aria-selected="false" tabindex="-1" data-work-view-key="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}"${view.attentionSequence === undefined ? "" : ` data-attention-sequence="${view.attentionSequence}"`} data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="${escapeHtml(view.sourceKey ?? view.key)}" data-atelier-fullscreen-title-value="${escapeHtml(view.label)}" data-action="click->workspace-presentation#selectWorkView">${actionItemLabel(view.label)}${view.attentionSequence === undefined ? "" : '<i class="fixed-shell-attention-dot action-item__status" aria-label="Attention"></i>'}</button>${view.close ? workViewCloseForm(view.close) : ""}
  </div>`;
}

function renderWorkViewSelectors(views: readonly WorkPaneContribution[]): string {
  return views.map(renderWorkViewSelector).join("");
}

function renderWorkViewPane(view: WorkPaneContribution, preserved?: ReadonlySet<string>): string {
  return renderLiveNode(`work:${view.key}`, "work", view.key, `${view.actionsHtml ? `<div class="fixed-shell-work-actions">${view.actionsHtml}</div>` : ""}${view.bodyHtml}`, preserved, view);
}

function workViewDomId(workspaceId: string, part: string): string {
  return domId("fixed_workspace", workspaceId, part);
}

function renderWorkPane(presentation: WorkspacePresentation): string {
  const selectors = renderWorkViewSelectors(presentation.workViews);
  const panes = presentation.workViews.map((view) => renderWorkViewPane(view, presentation.preserveLiveKeys)).join("");
  const workCommands = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher");
  const addMenu = workCommands.length ? `<details class="fixed-shell-add-menu"><summary class="button primary icon-only" title="Open Work view" aria-label="Open Work view">${icon("plus")}</summary><div>${workCommands.map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.label)}</button></form>`).join("")}</div></details>` : "";
  return `<section class="fixed-shell-work-pane" data-workspace-role-region="work" data-workspace-presentation-target="workPane" aria-label="Work">
    <header><div id="${workViewDomId(presentation.workspace.id, "selectors")}" class="fixed-shell-work-view-selectors" role="tablist" aria-label="Work views">${selectors}</div>${addMenu}${topBarButton("Collapse Work pane", "click->workspace-presentation#toggleWorkPane", "panel", "data-collapse-work-pane")}</header>
    <div id="${workViewDomId(presentation.workspace.id, "bodies")}" class="fixed-shell-work-bodies">${panes || `<div id="${workViewDomId(presentation.workspace.id, "empty")}" class="fixed-shell-empty-work">Open Files, a file, terminal, or browser to work alongside the Agent.</div>`}</div>
    <div class="fixed-shell-work-resizer" role="separator" aria-label="Resize Work pane" aria-orientation="vertical" tabindex="0" data-action="pointerdown->workspace-presentation#beginWorkResize keydown->workspace-presentation#resizeWorkWithKeyboard"></div>
  </section>`;
}

function mobileWorkIcon(view: WorkPaneContribution): IconName {
  if (view.key.startsWith("browser:")) return "browser";
  if (view.key.startsWith("terminal:")) return "terminal";
  return "file";
}

function renderMobileDirectWorkViews(views: readonly WorkPaneContribution[]): string {
  return views.filter((view) => view.mobileDestination === "direct").map((view) => `<button type="button" aria-label="${escapeHtml(view.label)}" title="${escapeHtml(view.label)}" data-mobile-destination="work:${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMobileDestination">${icon(mobileWorkIcon(view))}${view.attentionSequence === undefined ? "" : '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>'}</button>`).join("");
}

function renderMobileSecondaryWorkViews(views: readonly WorkPaneContribution[]): string {
  return views.filter((view) => view.mobileDestination === "more").map((view) => `<button type="button" data-more-work-key="${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMoreWorkView">${escapeHtml(view.label)}${view.attentionSequence === undefined ? "" : '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>'}</button>`).join("") || "<p>No secondary views are available.</p>";
}

function renderMobileCloser(destination: string, close: ViewCloseAction): string {
  return `<div data-more-close-destination="${escapeHtml(destination)}" hidden>${closeForm(close, '<button class="fixed-shell-more-close-current" type="submit">Close current view</button>')}</div>`;
}

function renderMobileWorkViewCloser(view: WorkPaneContribution): string {
  return view.close ? renderMobileCloser(`work:${view.key}`, view.close) : "";
}

function renderMobileNavigation(presentation: WorkspacePresentation): string {
  const agents = presentation.agentConversations.map((agent) => `<button type="button" aria-label="${escapeHtml(agent.title)}" title="${escapeHtml(agent.title)}" data-mobile-destination="agent:${escapeHtml(agent.id)}" data-action="click->workspace-presentation#selectMobileDestination">${icon("agent")}</button>`).join("");
  const direct = renderMobileDirectWorkViews(presentation.workViews);
  const openSecondary = renderMobileSecondaryWorkViews(presentation.workViews);
  const filesCommand = presentation.workViews.some((view) => view.key.startsWith("files:")) ? undefined : presentation.commands?.find((command) => command.id === "files.open");
  const closedSingletons = filesCommand ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(filesCommand.id)}"><button type="submit">${escapeHtml(filesCommand.label)}</button></form>` : "";
  const launcherCommands = new Set(["terminal.create", "terminal.attach", "browser.create", "vscode.open", "desktop.open"]);
  const launchers = (presentation.commands ?? []).filter((command) => launcherCommands.has(command.id)).map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.label)}</button></form>`).join("");
  const closers = presentation.agentConversations.map((agent) => agent.close ? renderMobileCloser(`agent:${agent.id}`, agent.close) : "").join("")
    + presentation.workViews.map(renderMobileWorkViewCloser).join("");
  const hiddenAttention = presentation.workViews.some((view) => view.mobileDestination === "more" && view.attentionSequence !== undefined);
  return `<nav class="fixed-shell-mobile-nav" aria-label="Workspace destinations">
    <button class="fixed-shell-mobile-fixed" type="button" aria-label="Workspace" title="Workspace" data-mobile-destination="workspace" data-action="click->workspace-presentation#selectMobileDestination">${icon("workspace")}</button>
    <div class="fixed-shell-mobile-scroll">${agents}<span id="${workViewDomId(presentation.workspace.id, "mobile_direct")}" class="fixed-shell-mobile-work-items">${direct}</span></div>
    <button class="fixed-shell-mobile-fixed" type="button" aria-label="More" title="More" data-mobile-more data-action="click->workspace-presentation#toggleMore">${icon("more")}${hiddenAttention ? '<i class="fixed-shell-attention-dot" aria-label="Hidden Attention"></i>' : ""}</button>
    <section class="fixed-shell-more-menu" data-workspace-presentation-target="moreMenu" aria-label="More" hidden>
      <header><button type="button" class="fixed-shell-more-close" aria-label="Close More" data-action="click->workspace-presentation#toggleMore">${icon("close")}</button></header>
      <div class="fixed-shell-more-section"><span id="${workViewDomId(presentation.workspace.id, "mobile_secondary")}" class="fixed-shell-mobile-work-items">${openSecondary}</span>${closedSingletons}</div>
      <div class="fixed-shell-more-section"><h2>Open or create</h2>${launchers}</div>
      <div id="${workViewDomId(presentation.workspace.id, "mobile_closers")}" class="fixed-shell-more-section fixed-shell-more-close-section">${closers}</div>
    </section>
  </nav>`;
}

function renderDeletionIssues(deletion: Extract<WorkspaceDeletionState, { status: "blocked" }>): string {
  return deletion.issues.map((issue) => `<section class="workspace-deletion-issue"><h3>${escapeHtml(issue.repo)}</h3>
    ${issue.uncommittedPaths.length > 0 ? `<h4>Uncommitted/staged paths</h4><ul>${issue.uncommittedPaths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}</ul>` : ""}
    ${issue.outgoingCommits.length > 0 ? `<h4>Unpushed commits</h4><ul>${issue.outgoingCommits.map((commit) => `<li><code>${escapeHtml(commit.hash.slice(0, 12))}</code> ${escapeHtml(commit.subject)}</li>`).join("")}</ul>` : ""}
  </section>`).join("");
}

export function renderWorkspaceDeletionPresentation(workspaceId: string, deletion: WorkspaceDeletionState): string {
  const id = encodeURIComponent(workspaceId);
  let content: string;
  if (deletion.status === "checking") {
    content = '<span class="status-spinner" aria-hidden="true"></span><h1>Checking if it’s safe to delete…</h1><p>Atelier is checking for uncommitted changes and unpushed commits.</p>';
  } else if (deletion.status === "deleting") {
    const title = deletion.forced ? "Force deleting workspace…" : "Deleting workspace…";
    const detail = deletion.forced ? "Local changes or unpushed commits may be discarded." : "The safety check passed. Atelier is removing the workspace.";
    content = `<span class="status-spinner" aria-hidden="true"></span><h1>${title}</h1><p>${detail}</p>`;
  } else if (deletion.status === "blocked") {
    content = `<h1>Please confirm it's okay to delete the workspace with these outstanding changes.</h1><div class="workspace-deletion-issues">${renderDeletionIssues(deletion)}</div><div class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true"><button class="button secondary" type="submit">Cancel deletion</button></form><form method="post" action="/workspaces/${id}/delete?force=1" data-turbo="true"><button class="button danger" type="submit">Delete anyway</button></form></div>`;
  } else {
    content = `<h1>Workspace deletion failed</h1><p class="workspace-deletion-error">${escapeHtml(deletion.error)}</p><div class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true"><button class="button secondary" type="submit">Cancel deletion</button></form><form method="post" action="/workspaces/${id}/delete/retry" data-turbo="true"><button class="button danger" type="submit">Retry deletion</button></form></div>`;
  }
  return `<div id="${domId("fixed_workspace", workspaceId)}" class="fixed-workspace-presentation workspace-deletion-presentation" data-workspace-id="${escapeHtml(workspaceId)}"><main class="workspace-deletion-state" role="${deletion.status === "failed" ? "alert" : "status"}">${content}</main></div>`;
}

export function renderWorkspacePresentation(presentation: WorkspacePresentation): string {
  if (presentation.agentConversations.length === 0) throw new Error("Workspace presentation requires an Agent conversation");
  const id = domId("fixed_workspace", presentation.workspace.id);
  return `<div id="${id}" class="fixed-workspace-presentation" data-controller="workspace-presentation" data-workspace-presentation-workspace-id-value="${escapeHtml(presentation.workspace.id)}" data-workspace-id="${escapeHtml(presentation.workspace.id)}" data-workspace-commands="${escapeHtml(JSON.stringify(presentation.commands ?? []))}">
    <div class="fixed-shell-main">${renderAgentPane(presentation)}${renderWorkPane(presentation)}</div>
    ${renderMobileNavigation(presentation)}
    ${(presentation.overlayHtml ?? []).join("")}
  </div>`;
}

export function workspacePresentationTurboStream(workspaceId: string, presentation: WorkspacePresentation): string {
  return `<turbo-stream action="replace-workspace-presentation" target="${escapeHtml(domId("fixed_workspace", workspaceId))}"><template>${renderWorkspacePresentation(presentation)}</template></turbo-stream>`;
}

export function presentWorkViewTurboStream(workspaceId: string, key: string): string {
  return `<turbo-stream action="present-work-view" target="${escapeHtml(domId("fixed_workspace", workspaceId))}" data-work-view-key="${escapeHtml(key)}"></turbo-stream>`;
}

export function openWorkViewTurboStream(workspaceId: string, workViews: readonly WorkPaneContribution[], openedKey: string): string {
  const opened = workViews.find((view) => view.key === openedKey);
  if (!opened) throw new Error(`Opened Work view is missing from the presentation: ${openedKey}`);
  return [
    turboStream("update", workViewDomId(workspaceId, "selectors"), renderWorkViewSelectors(workViews)),
    turboStream("remove", workViewDomId(workspaceId, "empty")),
    turboStream("append", workViewDomId(workspaceId, "bodies"), renderWorkViewPane(opened)),
    turboStream("update", workViewDomId(workspaceId, "mobile_direct"), renderMobileDirectWorkViews(workViews)),
    turboStream("update", workViewDomId(workspaceId, "mobile_secondary"), renderMobileSecondaryWorkViews(workViews)),
    turboStream("append", workViewDomId(workspaceId, "mobile_closers"), renderMobileWorkViewCloser(opened)),
  ].join("");
}

export function removeWorkspaceResidentTurboStream(workspaceId: string): string {
  return `<turbo-stream action="remove-workspace-resident" target="${escapeHtml(domId("fixed_workspace", workspaceId))}"></turbo-stream>`;
}

export function workspacePaneCollectionsTurboStream(presentation: WorkspacePanePresentation): string {
  return `<turbo-stream action="replace-workspace-pane-collections" targets="[data-workspace-pane-collections]"><template>${renderWorkspacePaneCollections(presentation)}</template></turbo-stream>`;
}
