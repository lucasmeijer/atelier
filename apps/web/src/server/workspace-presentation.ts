import { domId, escapeHtml } from "@atelier/shared";

export type WorkViewAvailability =
  | { phase: "opening"; detail?: string }
  | { phase: "live" }
  | { phase: "reconnecting"; detail?: string }
  | { phase: "unavailable"; detail: string; recoveryHtml?: string };

export interface WorkspacePaneEntry {
  id: string;
  title: string;
  color?: string;
  active?: boolean;
  busy?: boolean;
  ready?: boolean;
}

export interface WorkspacePaneProject {
  id: string;
  title: string;
  workspaces: readonly WorkspacePaneEntry[];
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
  parkedWorkspaces?: readonly (WorkspacePaneEntry & { projectTitle?: string })[];
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

type IconName = "agent" | "browser" | "chevron" | "close" | "file" | "more" | "panel" | "plus" | "settings" | "sidebar" | "terminal" | "trash" | "workspace";

function icon(name: IconName): string {
  const paths = {
    agent: '<path d="M9 4h6M12 4V2M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>',
    browser: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    close: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    file: '<path d="M7 3h7l4 4v14H7zM14 3v5h4"/>',
    panel: '<path d="M4 4h16v16H4zM15 4v16"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
    sidebar: '<path d="M4 4h16v16H4zM9 4v16"/>',
    terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    workspace: '<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>',
  } as const;
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}

function button(label: string, action: string, iconName: Parameters<typeof icon>[0], attributes = ""): string {
  return `<button type="button" class="fixed-shell-icon-button" aria-label="${escapeHtml(label)}" data-action="${action}" ${attributes}>${icon(iconName)}</button>`;
}

function closeForm(close: ViewCloseAction, buttonHtml: string, className = ""): string {
  return `<form class="${className}" data-turbo="true" method="post" action="${escapeHtml(close.action)}" data-close-label="${escapeHtml(close.label)}" data-action="submit->workspace-presentation#confirmClose">${buttonHtml}</form>`;
}

function selectorCloseForm(close: ViewCloseAction): string {
  return closeForm(close, `<button class="fixed-shell-view-close" type="submit" title="Close ${escapeHtml(close.label)}" aria-label="Close ${escapeHtml(close.label)}">×</button>`);
}

function renderWorkspaceRow(workspace: WorkspacePaneEntry, projectId?: string): string {
  const color = workspace.color ? ` style="--workspace-color:${escapeHtml(workspace.color)}"` : "";
  return `<button type="button" class="fixed-shell-workspace-row${workspace.active ? " active" : ""}" title="${escapeHtml(workspace.title)}"${workspace.active ? ' aria-current="page"' : ""} data-workspace-entry-id="${escapeHtml(workspace.id)}" ${projectId ? `data-project-id="${escapeHtml(projectId)}"` : ""}${color} data-action="click->workspace-navigation#selectWorkspace">
    <i class="fixed-shell-workspace-color" aria-hidden="true"></i><span>${escapeHtml(workspace.title)}</span>${workspace.busy ? '<i class="status-spinner sm fixed-shell-workspace-busy" aria-label="Workspace busy" title="Workspace busy"></i>' : workspace.ready ? '<i class="fixed-shell-attention-dot" aria-label="Agent ready"></i>' : ""}
  </button>`;
}

const projectlessWorkspaceGroupId = "__projectless__";
const emptyProjectsGroupId = "__projects__";

interface WorkspaceGroupAddAction {
  href: string;
  frame: "agent_launch_modal" | "project_editor_frame";
  label: string;
}

const projectEditorTarget = 'data-turbo-frame="project_editor_frame" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="project-editor-modal"';

function renderWorkspaceGroupHeading(id: string, title: string, add: WorkspaceGroupAddAction, settingsHref?: string, collapsible = true): string {
  const heading = collapsible
    ? `<button type="button" class="fixed-shell-project-heading" aria-expanded="true" data-action="click->workspace-navigation#toggleProject" data-project-id="${escapeHtml(id)}">${icon("chevron")}<span>${escapeHtml(title)}</span></button>`
    : `<span class="fixed-shell-project-heading fixed-shell-project-heading-static"><span>${escapeHtml(title)}</span></span>`;
  const settings = settingsHref ? `<a class="fixed-shell-project-action fixed-shell-project-settings" href="${escapeHtml(settingsHref)}" ${projectEditorTarget} aria-label="Project settings: ${escapeHtml(title)}" title="Project settings: ${escapeHtml(title)}">${icon("more")}</a>` : "";
  const addTarget = add.frame === "project_editor_frame" ? projectEditorTarget : 'data-turbo-frame="agent_launch_modal"';
  return `<div class="fixed-shell-project-heading-row">${heading}${settings}<a class="fixed-shell-project-action fixed-shell-project-add" href="${escapeHtml(add.href)}" ${addTarget} aria-label="${escapeHtml(add.label)}" title="${escapeHtml(add.label)}">${icon("plus")}</a></div>`;
}

function renderProjectHeading(project: Pick<WorkspacePaneProject, "id" | "title">, collapsible = true): string {
  const id = encodeURIComponent(project.id);
  return renderWorkspaceGroupHeading(project.id, project.title, { href: `/projects/${id}/agent-launch`, frame: "agent_launch_modal", label: `New workspace: ${project.title}` }, `/projects/${id}/editor`, collapsible);
}

export function renderWorkspacePaneCollections(presentation: WorkspacePanePresentation): string {
  const projects = presentation.projects.map((project) => `<section class="fixed-shell-project" data-project-id="${escapeHtml(project.id)}">
    ${renderProjectHeading(project)}
    <div class="fixed-shell-project-workspaces">${project.workspaces.map((workspace) => renderWorkspaceRow(workspace, project.id)).join("")}</div>
  </section>`).join("");
  const projectlessWorkspaces = presentation.projectlessWorkspaces ?? [];
  const projectlessAdd = { href: "/agent-launch", frame: "agent_launch_modal", label: "New projectless workspace" } as const;
  const emptyProjectless = projectlessWorkspaces.length === 0 ? `<section class="fixed-shell-project" data-project-id="${projectlessWorkspaceGroupId}">${renderWorkspaceGroupHeading(projectlessWorkspaceGroupId, "Projectless", projectlessAdd, undefined, false)}</section>` : "";
  const emptyProjects = `<section class="fixed-shell-project fixed-shell-empty-projects" data-project-id="${emptyProjectsGroupId}">
    ${renderWorkspaceGroupHeading(emptyProjectsGroupId, "Projects", { href: "/projects/new/editor", frame: "project_editor_frame", label: "New project" })}
    <div class="fixed-shell-project-workspaces">${emptyProjectless}${(presentation.emptyProjects ?? []).map((project) => `<section class="fixed-shell-project" data-project-id="${escapeHtml(project.id)}">${renderProjectHeading(project, false)}</section>`).join("")}</div>
  </section>`;
  const projectless = projectlessWorkspaces.length > 0 ? `<section class="fixed-shell-project" data-project-id="${projectlessWorkspaceGroupId}">
    ${renderWorkspaceGroupHeading(projectlessWorkspaceGroupId, "Projectless", projectlessAdd)}
    <div class="fixed-shell-project-workspaces">${projectlessWorkspaces.map((workspace) => renderWorkspaceRow(workspace)).join("")}</div>
  </section>` : "";
  const parked = presentation.parkedWorkspaces?.length
    ? `<section class="fixed-shell-project fixed-shell-parked"><h3>Parked</h3>${presentation.parkedWorkspaces.map((workspace) => `${renderWorkspaceRow(workspace)}${workspace.projectTitle ? `<small>${escapeHtml(workspace.projectTitle)}</small>` : ""}`).join("")}</section>`
    : "";
  return `${projects}${projectless}${emptyProjects}${parked}`;
}

export function renderWorkspacePane(presentation: WorkspacePanePresentation, sidebarContributionsHtml = ""): string {
  return `<aside class="fixed-shell-workspace-pane" aria-label="Workspaces">
    <header><strong>Atelier</strong>${button("Close Workspace pane", "click->workspace-navigation#togglePane", "sidebar", 'data-expanded-pane-toggle="workspace"')}${button("Open Workspace pane", "click->workspace-navigation#togglePane", "sidebar", 'data-collapsed-pane-toggle="workspace"')}</header>
    <div class="fixed-shell-workspace-scroll" data-workspace-navigation-target="scroll"><div data-workspace-pane-collections>${renderWorkspacePaneCollections(presentation)}</div></div>
    <section id="global_sidebar_contributions">${sidebarContributionsHtml}</section>
    <footer><a class="fixed-shell-settings" href="/settings" data-turbo-frame="_top" data-turbo-stream="true">${icon("settings")}<span>Settings</span></a></footer>
  </aside>`;
}

function renderAgentPane(presentation: WorkspacePresentation): string {
  const multiple = presentation.agentConversations.length > 1;
  const title = multiple
    ? `<div class="fixed-shell-agent-conversations" role="tablist" aria-label="Agent conversations">${presentation.agentConversations.map((agent) => `<div class="fixed-shell-agent-conversation"><button type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-conversation-id="${escapeHtml(agent.id)}" data-action="click->workspace-presentation#selectAgent">${escapeHtml(agent.title)}</button>${agent.close ? selectorCloseForm(agent.close) : ""}</div>`).join("")}</div>`
    : `<div class="fixed-shell-workspace-title"><strong>${escapeHtml(presentation.workspace.title)}</strong></div>`;
  const panes = presentation.agentConversations.map((agent) => renderLiveNode(`agent:${agent.id}`, "agent", agent.id, agent.bodyHtml, presentation.preserveLiveKeys)).join("");
  const agentActions = (presentation.commands ?? []).filter((command) => command.placement === "agent-action").map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button class="fixed-shell-icon-button" type="submit" aria-label="${escapeHtml(command.label)}">＋</button></form>`).join("");
  const deleteWorkspace = `<form class="fixed-shell-delete-workspace" data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/delete"><button class="fixed-shell-icon-button" type="submit" title="Delete workspace" aria-label="Delete workspace">${icon("trash")}</button></form>`;
  return `<section class="fixed-shell-agent-pane" data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent">
    <header>${title}${agentActions}${deleteWorkspace}${button("Open Work pane", "click->workspace-presentation#toggleWorkPane", "panel", 'data-collapsed-pane-toggle="work"')}</header>
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

function renderWorkPane(presentation: WorkspacePresentation): string {
  const selectors = presentation.workViews.map((view) => `<div class="fixed-shell-work-view-selector" draggable="true" data-work-view-reorder-key="${escapeHtml(view.key)}" data-action="dragstart->workspace-presentation#beginWorkReorder dragover->workspace-presentation#allowWorkReorder drop->workspace-presentation#finishWorkReorder">
    <button type="button" role="tab" aria-selected="false" tabindex="-1" data-work-view-key="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}"${view.attentionSequence === undefined ? "" : ` data-attention-sequence="${view.attentionSequence}"`} data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="view" data-atelier-fullscreen-view-key-value="${escapeHtml(view.sourceKey ?? view.key)}" data-atelier-fullscreen-title-value="${escapeHtml(view.label)}" data-action="click->workspace-presentation#selectWorkView">${escapeHtml(view.label)}${view.attentionSequence === undefined ? "" : '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>'}</button>${view.close ? selectorCloseForm(view.close) : ""}
  </div>`).join("");
  const panes = presentation.workViews.map((view) => renderLiveNode(`work:${view.key}`, "work", view.key, `${view.actionsHtml ? `<div class="fixed-shell-work-actions">${view.actionsHtml}</div>` : ""}${view.bodyHtml}`, presentation.preserveLiveKeys, view)).join("");
  const workCommands = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher");
  const addMenu = workCommands.length ? `<details class="fixed-shell-add-menu"><summary class="fixed-shell-icon-button" aria-label="Open Work view">+</summary><div>${workCommands.map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.label)}</button></form>`).join("")}</div></details>` : "";
  return `<section class="fixed-shell-work-pane" data-workspace-role-region="work" data-workspace-presentation-target="workPane" aria-label="Work">
    <header><div class="fixed-shell-work-view-selectors" role="tablist" aria-label="Work views">${selectors}</div>${addMenu}${button("Close Work pane", "click->workspace-presentation#toggleWorkPane", "panel", 'data-expanded-pane-toggle="work"')}</header>
    <div class="fixed-shell-work-bodies">${panes || '<div class="fixed-shell-empty-work">Open Files, a file, terminal, or browser to work alongside the Agent.</div>'}</div>
    <div class="fixed-shell-work-resizer" role="separator" aria-label="Resize Work pane" aria-orientation="vertical" tabindex="0" data-action="pointerdown->workspace-presentation#beginWorkResize keydown->workspace-presentation#resizeWorkWithKeyboard"></div>
  </section>`;
}

function mobileWorkIcon(view: WorkPaneContribution): IconName {
  if (view.key.startsWith("browser:")) return "browser";
  if (view.key.startsWith("terminal:")) return "terminal";
  return "file";
}

function renderMobileNavigation(presentation: WorkspacePresentation): string {
  const agents = presentation.agentConversations.map((agent) => `<button type="button" aria-label="${escapeHtml(agent.title)}" title="${escapeHtml(agent.title)}" data-mobile-destination="agent:${escapeHtml(agent.id)}" data-action="click->workspace-presentation#selectMobileDestination">${icon("agent")}</button>`).join("");
  const direct = presentation.workViews.filter((view) => view.mobileDestination === "direct").map((view) => `<button type="button" aria-label="${escapeHtml(view.label)}" title="${escapeHtml(view.label)}" data-mobile-destination="work:${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMobileDestination">${icon(mobileWorkIcon(view))}${view.attentionSequence === undefined ? "" : '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>'}</button>`).join("");
  const openSecondary = presentation.workViews.filter((view) => view.mobileDestination === "more").map((view) => `<button type="button" data-more-work-key="${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMoreWorkView">${escapeHtml(view.label)}${view.attentionSequence === undefined ? "" : '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>'}</button>`).join("");
  const filesCommand = presentation.workViews.some((view) => view.key.startsWith("files:")) ? undefined : presentation.commands?.find((command) => command.id === "files.open");
  const closedSingletons = filesCommand ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(filesCommand.id)}"><button type="submit">${escapeHtml(filesCommand.label)}</button></form>` : "";
  const secondary = `${openSecondary}${closedSingletons}`;
  const launcherCommands = new Set(["terminal.create", "terminal.attach", "browser.create", "vscode.open", "desktop.open"]);
  const launchers = (presentation.commands ?? []).filter((command) => launcherCommands.has(command.id)).map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.label)}</button></form>`).join("");
  const closers = [
    ...presentation.agentConversations.flatMap((agent) => agent.close ? [{ destination: `agent:${agent.id}`, close: agent.close }] : []),
    ...presentation.workViews.flatMap((view) => view.close ? [{ destination: `work:${view.key}`, close: view.close }] : []),
  ].map(({ destination, close }) => `<div data-more-close-destination="${escapeHtml(destination)}" hidden>${closeForm(close, '<button class="fixed-shell-more-close-current" type="submit">Close current view</button>')}</div>`).join("");
  const hiddenAttention = presentation.workViews.some((view) => view.mobileDestination === "more" && view.attentionSequence !== undefined);
  return `<nav class="fixed-shell-mobile-nav" aria-label="Workspace destinations">
    <button class="fixed-shell-mobile-fixed" type="button" aria-label="Workspace" title="Workspace" data-mobile-destination="workspace" data-action="click->workspace-presentation#selectMobileDestination">${icon("workspace")}</button>
    <div class="fixed-shell-mobile-scroll">${agents}${direct}</div>
    <button class="fixed-shell-mobile-fixed" type="button" aria-label="More" title="More" data-mobile-more data-action="click->workspace-presentation#toggleMore">${icon("more")}${hiddenAttention ? '<i class="fixed-shell-attention-dot" aria-label="Hidden Attention"></i>' : ""}</button>
    <section class="fixed-shell-more-menu" data-workspace-presentation-target="moreMenu" aria-label="More" hidden>
      <header><button type="button" class="fixed-shell-more-close" aria-label="Close More" data-action="click->workspace-presentation#toggleMore">${icon("close")}</button></header>
      <div class="fixed-shell-more-section">${secondary || "<p>No secondary views are available.</p>"}</div>
      <div class="fixed-shell-more-section"><h2>Open or create</h2>${launchers}</div>
      <div class="fixed-shell-more-section fixed-shell-more-close-section">${closers}</div>
    </section>
  </nav>`;
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

export function removeWorkspaceResidentTurboStream(workspaceId: string): string {
  return `<turbo-stream action="remove-workspace-resident" target="${escapeHtml(domId("fixed_workspace", workspaceId))}"></turbo-stream>`;
}

export function workspacePaneCollectionsTurboStream(presentation: WorkspacePanePresentation): string {
  return `<turbo-stream action="replace-workspace-pane-collections" targets="[data-workspace-pane-collections]"><template><div data-workspace-pane-collections>${renderWorkspacePaneCollections(presentation)}</div></template></turbo-stream>`;
}
