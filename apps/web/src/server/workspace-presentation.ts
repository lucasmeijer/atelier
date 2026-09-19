import { tabHtml, tabStripHtml } from "@atelier/design-system/tab-strip";
import { renderMobileAgentAttention, renderAgentPane, type AgentPaneContribution } from "./agent-pane.ts";
import { busyAttentionIndicator, barButton, fullscreenViewAttributes, selectorCloseForm, behaviorTurboStream, workspacePreparationInvalidatedTurboStream, type ViewCloseAction } from "./workspace-view-markup.ts";
import { actionItemHtml } from "@atelier/design-system/action-item";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml, type ButtonVariant } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { destructiveConfirmationHtml } from "@atelier/design-system/destructive-confirmation";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { panelHtml } from "@atelier/design-system/panel";
import { popupHtml } from "@atelier/design-system/popup";
import { domId, escapeHtml, turboStream, workspaceWorkViewLabelDomId } from "@atelier/shared";
import { renderPwaReminder } from "./pwa-reminder.ts";
import { atelierEasterEggHtml } from "./atelier-easter-egg.ts";
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
  parked: boolean;
  project?: { id: string; title: string };
  busy?: boolean;
  requestingAttention?: boolean;
  attentionAt?: number;
  lastActivityAt?: number;
  busyAgentKeys?: readonly string[];
  outdated?: boolean;
  issues?: readonly { message: string }[];
}

export interface WorkspacePaneProject {
  id: string;
  title: string;
  lastWorkspaceCreatedAt?: number;
}


export interface WorkPaneContribution {
  iconHtml?: string;
  /** Stable, type-native serialized identity supplied by the resource adapter. */
  key: string;
  label: string;
  kind: "resource" | "contextual";
  requestingAttention?: boolean;
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
  /** Already ordered by the workspace registry. */
  workspaces: readonly WorkspacePaneEntry[];
}

export type WorkspacePaneOnboardingState = "first-project" | "first-workspace" | "workspaces";

export function workspacePaneOnboardingState(presentation: WorkspacePanePresentation): WorkspacePaneOnboardingState {
  if (presentation.workspaces.length) return "workspaces";
  return presentation.projects.length ? "first-workspace" : "first-project";
}

export interface WorkspacePresentation {
  workspace: Pick<WorkspacePaneEntry, "id" | "title">;
  agentConversations: readonly AgentPaneContribution[];
  agentProviders: readonly { id: string; label: string; iconHtml: string }[];
  workViews: readonly WorkPaneContribution[];
  commands?: readonly { id: string; label: string; description?: string; scope: string; iconHtml?: string; placement?: "work-launcher" | "agent-action"; binding?: string }[];
  overlayHtml?: readonly string[];
  warningsHtml?: string;
}


function closeForm(close: ViewCloseAction, buttonHtml: string): string {
  return `<form data-turbo="true" method="post" action="${escapeHtml(close.action)}" data-close-label="${escapeHtml(close.label)}" data-action="submit->workspace-presentation#confirmClose">${buttonHtml}</form>`;
}

function workspaceStatusSlot(content: string): string {
  return `<span class="fixed-shell-workspace-status action-item__status">${content}</span>`;
}

function renderWorkspaceRowStatus(workspace: WorkspacePaneEntry): string {
  if (workspace.busy || workspace.requestingAttention) {
    return workspaceStatusSlot(busyAttentionIndicator(workspace));
  }
  const issues = (workspace.issues ?? []).map((issue) => issue.message);
  if (workspace.outdated) issues.push("Workspace created with an older version of Atelier. Some newer features may require a new workspace.");
  return issues.length
    ? workspaceStatusSlot(`<i class="fixed-shell-workspace-warning" aria-label="${escapeHtml(issues.join("\n"))}" title="${escapeHtml(issues.join("\n"))}">⚠︎</i>`)
    : "";
}

function renderWorkspaceRow(workspace: WorkspacePaneEntry): string {
  const { parked, project } = workspace;
  const id = workspaceRowDomId(workspace.id);
  const attentionAt = workspace.attentionAt === undefined ? "" : ` data-workspace-attention-at="${workspace.attentionAt}"`;
  const lastActivityAt = workspace.lastActivityAt === undefined ? "" : ` data-workspace-last-activity-at="${workspace.lastActivityAt}"`;
  const projectAttribute = project ? ` data-project-id="${escapeHtml(project.id)}"` : "";
  const busyAgents = workspace.busyAgentKeys?.length ? ` data-workspace-busy-agents="${escapeHtml(JSON.stringify(workspace.busyAgentKeys))}"` : "";
  const label = parked ? `Unpark and open ${workspace.title}` : workspace.title;
  const tooltip = [project?.title, label].filter(Boolean).join(" · ");
  const row = actionItemHtml({
    kind: "single",
    label: { kind: "text", text: workspace.title },
    trailingHtml: renderWorkspaceRowStatus(workspace),
    element: {
      tag: "button",
      attributesHtml: `${parked ? 'data-workspace-parked' : `id="${id}"`} type="${parked ? "submit" : "button"}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(label)}"${workspace.active ? ' aria-current="page"' : ""} data-workspace-entry-id="${escapeHtml(workspace.id)}"${attentionAt}${lastActivityAt}${busyAgents}${projectAttribute}${parked ? "" : ' data-action="click->workspace-navigation#selectWorkspace"'}`,
    },
  });
  return parked
    ? `<form id="${id}" method="post" action="/workspaces/${encodeURIComponent(workspace.id)}/unpark" data-action="submit->workspace-navigation#unparkWorkspace">${row}</form>`
    : row;
}

const projectDialogTarget = 'data-turbo-frame="_top" data-turbo-stream="true"';

function renderProjectHeading(project: Pick<WorkspacePaneProject, "id" | "title">, onboardingDestination?: "first-workspace"): string {
  const id = encodeURIComponent(project.id);
  const href = `/projects/${id}/launch-composer`;
  const settings = actionLinkHtml({
    href: `/projects/${id}/settings`, variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.More, label: `Project settings: ${project.title}` },
    attributesHtml: projectDialogTarget,
  });
  const add = actionLinkHtml({
    href, variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: `New workspace: ${project.title}` },
    attributesHtml: `data-turbo-frame="launch_composer"${onboardingDestination ? ` data-empty-workspace-onboarding-destination="${onboardingDestination}"` : ""}`,
  });
  return actionItemHtml({ kind: "compound", label: { kind: "text", text: project.title },
    primary: { tag: "a", attributesHtml: `href="${escapeHtml(href)}" data-turbo-frame="launch_composer"` },
    engagedActionsHtml: buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml: settings + add }),
  });
}

function workspaceRowDomId(id: string): string { return domId("workspace_row", id); }

function workspaceRows(presentation: WorkspacePanePresentation): Array<{ id: string; html: string }> {
  return presentation.workspaces.map((workspace) => ({ id: workspaceRowDomId(workspace.id), html: renderWorkspaceRow(workspace) }));
}

function renderProjectsPane(presentation: WorkspacePanePresentation): string {
  const paneProjects = [...presentation.projects].sort((left, right) => (right.lastWorkspaceCreatedAt ?? 0) - (left.lastWorkspaceCreatedAt ?? 0) || left.title.localeCompare(right.title));
  const onboardingState = workspacePaneOnboardingState(presentation);
  const needsFirstProject = onboardingState === "first-project";
  const needsFirstWorkspace = onboardingState === "first-workspace";
  const addProject = actionLinkHtml({
    href: "/projects/new",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Plus, label: "New project" },
    attributesHtml: `${projectDialogTarget}${needsFirstProject ? ' data-empty-workspace-onboarding-destination="first-project"' : ""}`,
  });
  const collapseProjects = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Disclosure, label: "Collapse Projects pane" },
    attributesHtml: 'data-action="projects-pane#toggle" data-projects-pane-target="toggle" aria-expanded="true" aria-controls="workspace_projects_list"',
  });
  return `<div id="${workspaceProjectsPaneDomId}" class="fixed-shell-projects-pane" data-controller="projects-pane">${panelHtml({
    element: { tag: "section", attributesHtml: 'aria-label="Projects"' },
    headerHtml: `<span class="panel__title">${Icons.Projects}Projects</span>${buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml: `${collapseProjects}${addProject}` })}`,
    bodyOverflow: "scroll",
    bodyHtml: `<div id="workspace_projects_list" class="fixed-shell-projects-list action-list" data-projects-pane-target="list">${paneProjects.length
      ? paneProjects.map((project, index) => renderProjectHeading(project, needsFirstWorkspace && index === 0 ? "first-workspace" : undefined)).join("")
      : '<p class="fixed-shell-projects-empty">No projects yet, make one!<svg class="fixed-shell-projects-empty-arrow" width="40" height="36" viewBox="0 0 40 36" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 30 Q30 30 30 3 M24 9 L30 3 L36 9" /></svg></p>'}</div>`,
  })}</div>`;
}

const workspacePaneScrollDomId = "fixed_shell_workspace_scroll";
const workspaceProjectsPaneDomId = "fixed_shell_projects_pane";

export function renderWorkspacePane(presentation: WorkspacePanePresentation, sidebarContributionsHtml = "", moduleActionsHtml = ""): string {
  const settings = actionLinkHtml({
    href: "/settings",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: Icons.Settings, label: "Settings" },
    attributesHtml: 'data-controller="settings-prefetch" data-action="pointerenter->settings-prefetch#prefetch focus->settings-prefetch#prefetch click->settings-prefetch#open"',
  });
  return `<div class="fixed-shell-workspace-pane"><div class="fixed-shell-workspace-main">${panelHtml({
    element: { tag: "aside",  attributesHtml: 'aria-label="Workspaces"' },
    headerHtml: `<strong class="panel__title">${atelierEasterEggHtml()}Atelier</strong>${buttonGroupHtml({ orientation: "horizontal", semantics: "layout", itemsHtml: `${renderPwaReminder()}${moduleActionsHtml}${settings}${barButton("Collapse Workspace pane", "click->workspace-navigation#toggleWorkspacePaneCollapsed", Icons.Panel, "data-collapse-workspace-pane")}` })}`,
    bodyHtml: `<div class="fixed-shell-pane-collections" data-workspace-pane-collections>
      <div id="${workspacePaneScrollDomId}" class="fixed-shell-workspace-scroll" data-workspace-navigation-target="scroll">${workspaceRows(presentation).map((row) => row.html).join("")}</div>
      <section id="global_sidebar_contributions">${sidebarContributionsHtml}</section>
    </div>`,
  })}</div>${renderProjectsPane(presentation)}</div>`;
}

const atelierNextAttentionDomId = "fixed_shell_atelier_next_attention";

function renderAtelierNextAttentionButton(): string {
  const icon = `${Icons.Next}<i class="status-dot attention" aria-hidden="true"></i>`;
  return barButton("Next workspace requesting attention", "click->atelier-shortcuts#openAttentionWorkspace", icon, `id="${atelierNextAttentionDomId}" disabled`);
}

export function renderAtelierBar(): string {
  const close = barButton("Close workspace list", "click->workspace-navigation#closeWorkspacePane", Icons.Close, "data-close-workspace-pane disabled");
  const newWorkspace = barButton("New Workspace With Same Project", "click->atelier-shortcuts#runCommand", Icons.Plus, 'data-command-id="agent.open-launch-composer"');
  return `<nav class="fixed-shell-mobile-nav fixed-shell-atelier-bar" data-popular-button aria-label="Atelier">${close}${renderAtelierNextAttentionButton()}${newWorkspace}</nav>`;
}

export function workspacePresentationDomId(workspaceId: string): string {
  return domId("fixed_workspace", workspaceId);
}

function workspaceRegionDomId(workspaceId: string, part: string): string {
  return domId("fixed_workspace", workspaceId, part);
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
  const textAttributesHtml = `id="${workspaceWorkViewLabelDomId(workspaceId, view.key)}"`;
  return tabHtml({
    selected: false,
    label: { kind: "text", text: view.label, textAttributesHtml },
    iconHtml: view.iconHtml ?? Icons.Plus,
    metadataHtml: view.attentionSequence === undefined ? "" : '<i class="status-dot attention action-item__status" aria-label="Attention"></i>',
    containerAttributesHtml: `id="${workViewSelectorDomId(workspaceId, view.key)}" draggable="true" data-work-view-reorder-key="${escapeHtml(view.key)}" data-action="dragstart->workspace-presentation#beginWorkReorder dragover->workspace-presentation#allowWorkReorder drop->workspace-presentation#finishWorkReorder"`,
    primary: { tag: "button", attributesHtml: `type="button" data-work-view-key="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}"${view.attentionSequence === undefined ? "" : ` data-attention-sequence="${view.attentionSequence}"`} ${fullscreenViewAttributes(view.sourceKey ?? view.key, view.label)} data-action="click->workspace-presentation#selectWorkView"` },
    closeHtml: view.close ? selectorCloseForm(view.close) : "",
  });
}

function renderWorkViewSelectors(workspaceId: string, views: readonly WorkPaneContribution[]): string {
  return views.map((view) => renderWorkViewSelector(workspaceId, view)).join("");
}

function renderWorkViewPane(workspaceId: string, view: WorkPaneContribution): string {
  const body = view.bodyHtml ?? (view.bodyUrl
    ? `<turbo-frame id="${workViewBodyFrameId(workspaceId, view.key)}" src="${escapeHtml(view.bodyUrl)}" loading="lazy" data-work-view-hydration data-action="turbo:before-frame-render->workspace-presentation#workBodyWillRender turbo:frame-render->workspace-presentation#bodyRendered turbo:frame-missing->workspace-presentation#bodyMissing turbo:frame-load->workspace-presentation#workBodyLoaded"><div class="work-view-hydration-loading" role="status" aria-label="Loading ${escapeHtml(view.label)}"><span class="status-spinner" aria-hidden="true"></span></div></turbo-frame>`
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

function renderWorkLauncherCommand(command: NonNullable<WorkspacePresentation["commands"]>[number], workspaceId: string, action = ""): string {
  const item = actionItemHtml({ kind: "single", label: { kind: "text", text: command.label }, leadingHtml: `<span class="popup-menu__icon">${command.iconHtml ?? Icons.Plus}</span>`, element: { tag: "button", attributesHtml: 'type="submit" role="menuitem"' } });
  const actionAttribute = action ? ` data-action="${action}"` : "";
  return `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(command.id)}"${actionAttribute}>${item}</form>`;
}

function renderWorkPane(presentation: WorkspacePresentation): string {
  const selectors = renderWorkViewSelectors(presentation.workspace.id, presentation.workViews);
  const panes = presentation.workViews.map((view) => renderWorkViewPane(presentation.workspace.id, view)).join("");
  const workCommands = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher");
  const addMenuId = workViewDomId(presentation.workspace.id, "add_menu");
  const addMenu = workCommands.length ? popupHtml({
    id: addMenuId,
    label: "Open Work view",
    trigger: { variant: "primary", content: { kind: "icon-only", iconHtml: Icons.Plus, label: "Open Work view" } },
    contentHtml: workCommands.map((command) => renderWorkLauncherCommand(command, presentation.workspace.id)).join(""),
  }) : "";
  return `<div class="fixed-shell-work-pane">${panelHtml({
    element: { tag: "section",  attributesHtml: 'data-workspace-role-region="work" data-workspace-presentation-target="workPane" aria-label="Work"' },
    headerHtml: `${tabStripHtml({ label: "Work views", tabsHtml: selectors, attributesHtml: `id="${workViewDomId(presentation.workspace.id, "selectors")}"` })}<span id="${workViewDomId(presentation.workspace.id, "launchers")}">${addMenu}</span>${barButton("Collapse Work pane", "click->workspace-presentation#toggleWorkPane", Icons.Panel, "data-collapse-work-pane")}`,
    bodyHtml: `<div id="${workViewDomId(presentation.workspace.id, "bodies")}" class="fixed-shell-work-bodies">${panes || `<div id="${workViewDomId(presentation.workspace.id, "empty")}" class="fixed-shell-empty-work empty-state">Open Files, a file, terminal, or browser to work alongside the Agent.</div>`}</div><div class="fixed-shell-work-resizer" role="separator" aria-label="Resize Work pane" aria-orientation="vertical" tabindex="0" data-action="pointerdown->workspace-presentation#beginWorkResize keydown->workspace-presentation#resizeWorkWithKeyboard"></div>`,
  })}</div>`;
}

function renderMobileDestination(label: string, destination: string, iconHtml: string, attention = false, workKey?: string): string {
  const attentionHtml = attention ? '<i class="status-dot attention" aria-label="Attention"></i>' : "";
  const workKeyAttribute = workKey === undefined ? "" : ` data-mobile-work-key="${escapeHtml(workKey)}"`;
  return buttonHtml({
    type: "button", variant: "secondary",
    content: { kind: "icon-only", iconHtml: `${iconHtml}${attentionHtml}`, label },
    attributesHtml: `${workKeyAttribute} data-mobile-destination="${escapeHtml(destination)}" data-action="click->workspace-presentation#selectMobileDestination"`,
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
    destinations: ordered.map((view) => renderMobileDestination(view.label, `work:${view.key}`, view.iconHtml ?? Icons.Plus, view.attentionSequence !== undefined, view.key)).join(""),
    overflowItems: ordered.map((view) => {

      const attention = view.attentionSequence === undefined ? "" : '<i class="status-dot attention action-item__status" aria-label="Attention"></i>';
      return actionItemHtml({
        kind: "single",
        label: { kind: "text", text: view.label },
        leadingHtml: view.iconHtml ?? Icons.Plus,
        trailingHtml: attention,
        element: { tag: "button", attributesHtml: `type="button" role="menuitemradio" aria-checked="false" hidden data-more-work-key="${escapeHtml(view.key)}" data-more-work-kind="${view.kind}" data-action="click->workspace-presentation#selectMoreWorkView"` },
      });
    }).join(""),
  };
}

function renderMobileCloser(destination: string, close: ViewCloseAction): string {
  const item = actionItemHtml({ kind: "single", tone: "danger", label: { kind: "text", text: "Close current view" }, leadingHtml: `<span class="popup-menu__icon">${Icons.Close}</span>`, element: { tag: "button",  attributesHtml: 'type="submit" role="menuitem"' } });
  return `<div data-more-close-destination="${escapeHtml(destination)}" hidden>${closeForm(close, item)}</div>`;
}

function renderMobileWorkViewCloser(view: WorkPaneContribution): string {
  return view.close ? renderMobileCloser(`work:${view.key}`, view.close) : "";
}

const mobileMoreAttentionHtml = '<i class="status-dot attention" aria-label="Hidden Attention" data-mobile-overflow-attention hidden></i>';

export function renderMobileWorkspaceBar(destinationsHtml = "", moreMenuHtml = ""): string {
  const workspace = barButton("Show workspaces", "click->workspace-navigation#showWorkspacePane", Icons.Workspace, "data-show-workspace-list");
  return `<nav class="fixed-shell-mobile-nav fixed-shell-workspace-bar" data-popular-button aria-label="Current Workspace destinations">
    <div class="fixed-shell-mobile-scroll" data-mobile-overflow-container>${workspace}${destinationsHtml}</div>
    ${moreMenuHtml}
  </nav>`;
}

function renderWorkspaceBar(presentation: WorkspacePresentation): string {
  const agentsDestination = renderMobileDestination("Agents", "agents", `${Icons.Agent}${renderMobileAgentAttention(presentation.workspace.id, presentation.agentConversations)}`);
  const workViews = renderMobileWorkViews(presentation.workViews);
  const launchers = (presentation.commands ?? []).filter((command) => command.placement === "work-launcher").map((command) => renderWorkLauncherCommand(command, presentation.workspace.id, "submit->workspace-presentation#closeMore")).join("");
  const closers = presentation.workViews.map(renderMobileWorkViewCloser).join("");
  const moreMenuId = workViewDomId(presentation.workspace.id, "mobile_more_menu");
  const moreMenu = popupHtml({
    id: moreMenuId, label: "More", placement: "above",
    trigger: { variant: "secondary", content: { kind: "icon-only", iconHtml: `${Icons.More}<span id="${workViewDomId(presentation.workspace.id, "mobile_more_attention")}">${mobileMoreAttentionHtml}</span>`, label: "More" }, attributesHtml: "data-mobile-more" },
    menuAttributesHtml: 'data-workspace-presentation-target="moreMenu" data-action="toggle->workspace-presentation#syncMore"',
    contentHtml: `<span id="${workViewDomId(presentation.workspace.id, "mobile_overflow")}" class="contents action-list">${workViews.overflowItems}</span>
      ${launchers ? `<hr class="popup-menu__separator" data-mobile-overflow-separator hidden>${launchers}` : ""}
      <div id="${workViewDomId(presentation.workspace.id, "mobile_closers")}" class="fixed-shell-more-close-section">${closers}</div>`,
  });
  return renderMobileWorkspaceBar(`${agentsDestination}<span id="${workViewDomId(presentation.workspace.id, "mobile_destinations")}" class="contents">${workViews.destinations}</span>`, moreMenu);
}

export function renderWorkspaceDeletionPresentation(workspaceId: string, deletion: WorkspaceDeletionState, evidenceHtml = ""): string {
  const id = encodeURIComponent(workspaceId);
  const deletionButton = (caption: string, variant: ButtonVariant = "secondary") => buttonHtml({
    type: "submit",
    variant,
    content: { kind: "caption", caption },
  });
  let content: string;
  if (deletion.status === "checking") {
    content = '<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>Checking if it’s safe to delete…</h1><p>Atelier is checking for uncommitted changes and unpushed commits.</p></div>';
  } else if (deletion.status === "deleting") {
    const title = deletion.forced ? "Force deleting workspace…" : "Deleting workspace…";
    const detail = deletion.forced ? "Local changes may be discarded." : "The safety check passed. Atelier is removing the workspace.";
    content = `<div class="workspace-deletion-heading"><span class="status-spinner" aria-hidden="true"></span><h1>${title}</h1><p>${detail}</p></div>`;
  } else if (deletion.status === "blocked") {
    content = `<div class="workspace-deletion-evidence" aria-label="Git work that may be lost">${evidenceHtml}</div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true">${deletionButton("Cancel deletion")}</form><form method="post" action="/workspaces/${id}/delete/confirm" data-turbo="true" data-controller="submit-shortcut" data-action="keydown@window->submit-shortcut#windowKeydown submit->submit-shortcut#submit turbo:submit-end->submit-shortcut#submitted"><input type="hidden" name="fingerprint" value="${escapeHtml(deletion.fingerprint)}">${deletionButton("Delete anyway", "danger")}</form></footer>`;
  } else {
    const bypass = deletion.operation === "checking" ? `<form method="post" action="/workspaces/${id}/delete?force=1" data-turbo="true">${deletionButton("Delete without review", "danger")}</form>` : "";
    content = `<div class="workspace-deletion-heading"><h1>${deletion.operation === "checking" ? "Deletion review failed" : "Workspace deletion failed"}</h1><p class="workspace-deletion-error">${escapeHtml(deletion.error)}</p></div><footer class="workspace-deletion-actions"><form method="post" action="/workspaces/${id}/delete/cancel" data-turbo="true">${deletionButton("Cancel deletion")}</form><form method="post" action="/workspaces/${id}/delete/retry" data-turbo="true">${deletionButton("Retry review")}</form>${bypass}</footer>`;
  }
  const role = deletion.status === "failed" ? ' role="alert"' : deletion.status === "blocked" ? "" : ' role="status"';
  return `<div id="${domId("fixed_workspace", workspaceId)}" class="fixed-workspace-presentation workspace-deletion-presentation" data-workspace-id="${escapeHtml(workspaceId)}" data-workspace-commands="[]"><main class="workspace-deletion-state" data-deletion-status="${deletion.status}"${role}>${content}</main>${renderMobileWorkspaceBar()}</div>`;
}

export function renderWorkspacePresentation(presentation: WorkspacePresentation): string {
  const id = workspacePresentationDomId(presentation.workspace.id);
  return `<div id="${id}" class="fixed-workspace-presentation" data-controller="workspace-presentation" data-workspace-presentation-workspace-id-value="${escapeHtml(presentation.workspace.id)}" data-workspace-id="${escapeHtml(presentation.workspace.id)}" data-workspace-commands="${escapeHtml(JSON.stringify(presentation.commands ?? []))}">
    <div class="fixed-shell-main">${renderAgentPane(presentation)}${renderWorkPane(presentation)}</div>
    ${renderWorkspaceBar(presentation)}
    ${(presentation.overlayHtml ?? []).join("")}
  </div>`;
}

export function presentWorkViewTurboStream(workspaceId: string, key: string): string {
  return behaviorTurboStream("present-work-view", workspaceId, { "work-view-key": key });
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

export function workspacePaneCollectionsTurboStream(presentation: WorkspacePanePresentation, previous?: WorkspacePanePresentation): string {
  const rows = workspaceRows(presentation);
  const before = new Map(previous ? workspaceRows(previous).map((row) => [row.id, row.html]) : []);
  const streams: string[] = [];
  // Reconnection reconciles membership without remounting the list or its controller.
  if (!previous) streams.push(`<turbo-stream action="prune-workspace-rows" target="${workspacePaneScrollDomId}" data-row-ids="${escapeHtml(JSON.stringify(rows.map((row) => row.id)))}"></turbo-stream>`);
  for (const id of before.keys()) if (!rows.some((row) => row.id === id)) streams.push(turboStream("remove", id));
  for (const row of rows) {
    if (before.get(row.id) === row.html) continue;
    streams.push(previous && before.has(row.id) ? turboStream("replace", row.id, row.html) : turboStream("append", workspacePaneScrollDomId, row.html));
  }
  // Keep the longest already-ordered subsequence. Only displaced rows move;
  // attention changes usually move exactly the row whose state changed.
  const positions = new Map([...before.keys()].map((id, index) => [id, index]));
  const chains: string[][] = [];
  for (const row of rows) {
    const position = positions.get(row.id);
    if (position === undefined) continue;
    let predecessor: string[] = [];
    for (const chain of chains) {
      if (positions.get(chain.at(-1)!)! < position && chain.length > predecessor.length) predecessor = chain;
    }
    chains.push([...predecessor, row.id]);
  }
  const stable = new Set(chains.sort((a, b) => b.length - a.length)[0] ?? []);
  for (let index = rows.length - 1; index >= 0; index--) {
    if (previous && stable.has(rows[index]!.id)) continue;
    streams.push(`<turbo-stream action="move-workspace-row" target="${rows[index]!.id}" data-before-id="${rows[index + 1]?.id ?? ""}"></turbo-stream>`);
  }
  const projects = renderProjectsPane(presentation);
  if (!previous || projects !== renderProjectsPane(previous)) streams.push(turboStream("replace", workspaceProjectsPaneDomId, projects));
  streams.push('<turbo-stream action="workspace-pane-changed" targets="[data-workspace-pane-collections]"></turbo-stream>');
  return streams.join("");
}

export function renderWorkspaceParkConfirmation(id: string, title: string): string {
  return dialogHtml({
    element: { id: domId("workspace_park_confirmation", id), attributesHtml: "data-dialog-auto-show" },
    iconHtml: Icons.Park,
    titleCaption: `Park “${title}”?`,
    bodyHtml: "<p>This workspace has terminal or VS Code views open. Their sessions cannot recover after parking. Force park will close these views before parking. Other views will be kept.</p>",
    footerHtml: `<form method="dialog">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "caption", caption: "Cancel" } })}</form><form method="post" action="/workspaces/${encodeURIComponent(id)}/park?force=1" data-action="submit->workspace-navigation#parkWorkspace">${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Force park" } })}</form>`,
  });
}

export function dismissWorkspaceParkConfirmationTurboStream(id: string): string {
  return turboStream("remove", domId("workspace_park_confirmation", id));
}
