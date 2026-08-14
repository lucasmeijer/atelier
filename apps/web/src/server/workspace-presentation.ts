import { domId, escapeHtml } from "@atelier/shared";

export type WorkViewAvailability =
  | { phase: "opening"; detail?: string }
  | { phase: "live" }
  | { phase: "reconnecting"; detail?: string }
  | { phase: "unavailable"; detail: string; recoveryHtml?: string };

export interface WorkspacePaneEntry {
  id: string;
  title: string;
  ready?: boolean;
}

export interface WorkspacePaneProject {
  id: string;
  title: string;
  workspaces: readonly WorkspacePaneEntry[];
}

export interface AgentPaneContribution {
  id: string;
  title: string;
  bodyHtml: string;
  closeHtml?: string;
}

export interface WorkPaneContribution {
  /** Stable, type-native serialized identity supplied by the resource adapter. */
  key: string;
  label: string;
  kind: "resource" | "contextual";
  attention: boolean;
  availability: WorkViewAvailability;
  bodyHtml: string;
  sourceKey?: string;
  actionsHtml?: string;
  closeHtml?: string;
}

export interface WorkspacePresentation {
  workspace: WorkspacePaneEntry & { projectTitle?: string };
  projects: readonly WorkspacePaneProject[];
  projectlessWorkspaces?: readonly WorkspacePaneEntry[];
  parkedWorkspaces?: readonly (WorkspacePaneEntry & { projectTitle?: string })[];
  agentConversations: readonly AgentPaneContribution[];
  workViews: readonly WorkPaneContribution[];
  commands?: readonly { id: string; label: string; description?: string; scope: string; binding?: string }[];
  /** Live nodes named here are transplanted from the current DOM by the Turbo seam. */
  preserveLiveKeys?: ReadonlySet<string>;
}

function icon(name: "menu" | "panel" | "more" | "settings" | "workspace"): string {
  const paths = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    panel: '<path d="M4 4h16v16H4zM15 4v16"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>',
    workspace: '<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>',
  } as const;
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}

function button(label: string, action: string, iconName: Parameters<typeof icon>[0], attributes = ""): string {
  return `<button type="button" class="fixed-shell-icon-button" aria-label="${escapeHtml(label)}" data-action="${action}" ${attributes}>${icon(iconName)}</button>`;
}

function renderWorkspaceRow(workspace: WorkspacePaneEntry, projectId?: string): string {
  return `<button type="button" class="fixed-shell-workspace-row" data-workspace-entry-id="${escapeHtml(workspace.id)}" ${projectId ? `data-project-id="${escapeHtml(projectId)}"` : ""} data-action="click->workspace-presentation#selectWorkspace">
    <span>${escapeHtml(workspace.title)}</span>${workspace.ready ? '<i class="fixed-shell-attention-dot" aria-label="Agent ready"></i>' : ""}
  </button>`;
}

function renderWorkspacePane(presentation: WorkspacePresentation): string {
  const projects = presentation.projects.map((project) => `<section class="fixed-shell-project" data-project-id="${escapeHtml(project.id)}">
    <button type="button" class="fixed-shell-project-heading" aria-expanded="true" data-action="click->workspace-presentation#toggleProject" data-project-id="${escapeHtml(project.id)}"><span>${escapeHtml(project.title)}</span><span aria-hidden="true">⌄</span></button>
    <div class="fixed-shell-project-workspaces">${project.workspaces.map((workspace) => renderWorkspaceRow(workspace, project.id)).join("")}</div>
  </section>`).join("");
  const projectless = presentation.projectlessWorkspaces?.length
    ? `<section class="fixed-shell-project"><h3>No project</h3>${presentation.projectlessWorkspaces.map((workspace) => renderWorkspaceRow(workspace)).join("")}</section>`
    : "";
  const parked = presentation.parkedWorkspaces?.length
    ? `<section class="fixed-shell-project fixed-shell-parked"><h3>Parked</h3>${presentation.parkedWorkspaces.map((workspace) => `${renderWorkspaceRow(workspace)}${workspace.projectTitle ? `<small>${escapeHtml(workspace.projectTitle)}</small>` : ""}`).join("")}</section>`
    : "";
  return `<aside class="fixed-shell-workspace-pane" data-workspace-presentation-target="workspacePane" aria-label="Workspaces">
    <header><strong>Atelier</strong>${button("Close Workspace pane", "click->workspace-presentation#toggleWorkspacePane", "menu")}</header>
    <div class="fixed-shell-workspace-scroll" data-workspace-presentation-target="workspaceScroll">${projects}${projectless}${parked}</div>
    <footer><button type="button" class="fixed-shell-settings" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="project-picker-modal"><span aria-hidden="true">＋</span><span>New workspace</span></button><a class="fixed-shell-settings" href="/settings" data-turbo-frame="_top" data-turbo-stream="true">${icon("settings")}<span>Settings</span></a></footer>
  </aside>`;
}

function renderAgentPane(presentation: WorkspacePresentation): string {
  const multiple = presentation.agentConversations.length > 1;
  const title = multiple
    ? `<div class="fixed-shell-agent-tabs" role="tablist" aria-label="Agent conversations">${presentation.agentConversations.map((agent) => `<div class="fixed-shell-agent-tab"><button type="button" role="tab" aria-selected="false" tabindex="-1" data-agent-tab-id="${escapeHtml(agent.id)}" data-action="click->workspace-presentation#selectAgent">${escapeHtml(agent.title)}</button>${agent.closeHtml ?? ""}</div>`).join("")}</div>`
    : `<div class="fixed-shell-workspace-title"><strong>${escapeHtml(presentation.workspace.title)}</strong>${presentation.workspace.projectTitle ? `<small>${escapeHtml(presentation.workspace.projectTitle)}</small>` : ""}</div>`;
  const panes = presentation.agentConversations.map((agent) => renderLiveNode(`agent:${agent.id}`, "agent", agent.id, agent.bodyHtml, presentation.preserveLiveKeys)).join("");
  return `<section class="fixed-shell-agent-pane" data-workspace-role-region="agent" data-workspace-presentation-target="agentPane" aria-label="Agent">
    <header>${button("Open Workspace pane", "click->workspace-presentation#toggleWorkspacePane", "menu")}${title}${button("Toggle Work pane", "click->workspace-presentation#toggleWorkPane", "panel")}</header>
    <div class="fixed-shell-agent-bodies">${panes}</div>
  </section>`;
}

function availabilityLabel(availability: WorkViewAvailability): string {
  if (availability.phase === "live") return "";
  return availability.phase === "opening" ? "Opening" : availability.phase === "reconnecting" ? "Reconnecting" : "Unavailable";
}

function renderAvailability(view: WorkPaneContribution): string {
  const { availability } = view;
  if (availability.phase === "live") return "";
  const detail = availability.detail ?? (availability.phase === "opening" ? `Opening ${view.label}…` : `Reconnecting ${view.label}…`);
  return `<div class="fixed-shell-availability fixed-shell-availability-${availability.phase}" role="${availability.phase === "unavailable" ? "alert" : "status"}">
    <span class="fixed-shell-availability-mark" aria-hidden="true"></span><strong>${availabilityLabel(availability)}</strong><p>${escapeHtml(detail)}</p>${availability.phase === "unavailable" ? availability.recoveryHtml ?? "" : ""}
  </div>`;
}

function renderLiveNode(key: string, role: "agent" | "work", id: string, bodyHtml: string, preserved?: ReadonlySet<string>, workView?: WorkPaneContribution): string {
  if (preserved?.has(key)) return `<span hidden data-workspace-live-slot="${escapeHtml(key)}"></span>`;
  return `<section class="fixed-shell-live-node" data-workspace-live-node="${escapeHtml(key)}" data-workspace-pane-role="${role}" data-workspace-pane-id="${escapeHtml(id)}"${workView?.sourceKey ? ` data-source-tab-key="${escapeHtml(workView.sourceKey)}"` : ""} tabindex="-1">${workView ? renderAvailability(workView) : ""}<div class="fixed-shell-live-body">${bodyHtml}</div></section>`;
}

function renderWorkPane(presentation: WorkspacePresentation): string {
  const tabs = presentation.workViews.map((view) => `<div class="fixed-shell-work-tab" data-work-tab-key="${escapeHtml(view.key)}">
    <button type="button" role="tab" aria-selected="false" tabindex="-1" data-work-view-key="${escapeHtml(view.key)}" data-work-view-kind="${view.kind}" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="tab" data-atelier-fullscreen-tab-key-value="${escapeHtml(view.sourceKey ?? view.key)}" data-atelier-fullscreen-title-value="${escapeHtml(view.label)}" data-action="click->workspace-presentation#selectWorkView">${escapeHtml(view.label)}${view.attention ? '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>' : ""}<span class="fixed-shell-work-status fixed-shell-work-status-${view.availability.phase}" aria-label="${availabilityLabel(view.availability) || "Live"}"></span></button>${view.closeHtml ?? ""}
  </div>`).join("");
  const panes = presentation.workViews.map((view) => renderLiveNode(`work:${view.key}`, "work", view.key, `${view.actionsHtml ? `<div class="fixed-shell-work-actions">${view.actionsHtml}</div>` : ""}${view.bodyHtml}`, presentation.preserveLiveKeys, view)).join("");
  const addMenu = presentation.commands?.length ? `<details class="fixed-shell-add-menu"><summary class="fixed-shell-icon-button" aria-label="Open view or conversation">+</summary><div>${presentation.commands.map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(presentation.workspace.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.label)}</button></form>`).join("")}</div></details>` : "";
  return `<section class="fixed-shell-work-pane" data-workspace-role-region="work" data-workspace-presentation-target="workPane" aria-label="Work">
    <header><div class="fixed-shell-work-tabs" role="tablist" aria-label="Work views">${tabs}</div>${addMenu}${button("Close Work pane", "click->workspace-presentation#toggleWorkPane", "panel")}</header>
    <div class="fixed-shell-work-bodies">${panes || '<div class="fixed-shell-empty-work">Open a file, terminal, browser, or Changes to work alongside the Agent.</div>'}</div>
    <div class="fixed-shell-work-resizer" role="separator" aria-label="Resize Work pane" aria-orientation="vertical" tabindex="0" data-action="pointerdown->workspace-presentation#beginWorkResize keydown->workspace-presentation#resizeWorkWithKeyboard"></div>
  </section>`;
}

function renderMobileNavigation(presentation: WorkspacePresentation): string {
  const resources = presentation.workViews.filter((view) => view.kind === "resource").map((view) => `<button type="button" data-mobile-destination="work:${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMobileDestination"><span>${escapeHtml(view.label)}</span>${view.attention ? '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>' : ""}</button>`).join("");
  const contextualDestinations = presentation.workViews.filter((view) => view.kind === "contextual").map((view) => `<button type="button" data-mobile-destination="work:${escapeHtml(view.key)}" data-mobile-contextual-key="${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMobileDestination" hidden><span>${escapeHtml(view.label)}</span>${view.attention ? '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>' : ""}</button>`).join("");
  const contextual = presentation.workViews.filter((view) => view.kind === "contextual").map((view) => `<button type="button" data-more-work-key="${escapeHtml(view.key)}" data-action="click->workspace-presentation#selectMoreWorkView">${escapeHtml(view.label)}${view.attention ? '<i class="fixed-shell-attention-dot" aria-label="Attention"></i>' : ""}</button>`).join("");
  const hiddenAttention = presentation.workViews.some((view) => view.kind === "contextual" && view.attention);
  return `<nav class="fixed-shell-mobile-nav" aria-label="Workspace destinations">
    <button type="button" data-mobile-destination="workspace" data-action="click->workspace-presentation#selectMobileDestination">${icon("workspace")}<span>Workspace</span></button>
    <button type="button" data-mobile-destination="agent" data-action="click->workspace-presentation#selectMobileDestination"><span class="fixed-shell-agent-glyph">A</span><span>Agent</span></button>
    ${resources}${contextualDestinations}
    <button type="button" data-mobile-destination="more" data-action="click->workspace-presentation#selectMobileDestination">${icon("more")}<span>More</span>${hiddenAttention ? '<i class="fixed-shell-attention-dot" aria-label="Hidden Attention"></i>' : ""}</button>
    <div class="fixed-shell-more-menu" data-workspace-presentation-target="moreMenu" hidden>${contextual || "<p>No other views</p>"}</div>
  </nav>`;
}

export function renderWorkspacePresentation(presentation: WorkspacePresentation): string {
  if (presentation.agentConversations.length === 0) throw new Error("Workspace presentation requires an Agent conversation");
  const id = domId("fixed_workspace", presentation.workspace.id);
  return `<div id="${id}" class="fixed-workspace-presentation" data-controller="workspace-presentation" data-workspace-presentation-workspace-id-value="${escapeHtml(presentation.workspace.id)}" data-workspace-id="${escapeHtml(presentation.workspace.id)}" data-workspace-commands="${escapeHtml(JSON.stringify(presentation.commands ?? []))}">
    ${renderWorkspacePane(presentation)}
    <div class="fixed-shell-main">${renderAgentPane(presentation)}${renderWorkPane(presentation)}</div>
    <button type="button" class="fixed-shell-overlay-scrim" aria-label="Close Workspace pane" data-action="click->workspace-presentation#closeWorkspacePane"></button>
    ${renderMobileNavigation(presentation)}
  </div>`;
}

export function workspacePresentationTurboStream(workspaceId: string, presentation: WorkspacePresentation): string {
  return `<turbo-stream action="replace-workspace-presentation" target="${escapeHtml(domId("fixed_workspace", workspaceId))}"><template>${renderWorkspacePresentation(presentation)}</template></turbo-stream>`;
}

/** Development-only typed composition used to evaluate the inactive shell before cutover. */
export function workspacePresentationPreviewFixture(): WorkspacePresentation {
  return {
    workspace: { id: "shell-preview", title: "Workspace shell implementation", projectTitle: "Atelier" },
    projects: [
      { id: "atelier", title: "Atelier", workspaces: [
        { id: "shell-preview", title: "Workspace shell implementation" },
        { id: "file-workflow", title: "File workflow", ready: true },
        { id: "residency", title: "Workspace residency" },
      ] },
      { id: "tooling", title: "Tooling", workspaces: [{ id: "release", title: "Prepare release notes" }] },
    ],
    projectlessWorkspaces: [{ id: "scratch", title: "Scratch workspace" }],
    parkedWorkspaces: [{ id: "parked", title: "Old visual experiment", projectTitle: "Atelier" }],
    agentConversations: [
      { id: "agent-plan", title: "Plan the shell", bodyHtml: `<div style="max-width:720px;margin:0 auto;padding:38px 30px;line-height:1.6"><p style="color:#9699a2">You</p><p>Build the inactive role-fixed Workspace shell and preserve live panes through navigation.</p><p style="margin-top:30px;color:#9699a2">Agent</p><p>The shared shell is in place. Agent conversations and Work views remain mounted, personal navigation is isolated per Workspace client, and only browser-profile preferences are shared.</p><pre style="margin-top:24px;padding:14px;border:1px solid #2a2c31;border-radius:8px;background:#0d0e10;color:#c8cad0;overflow:auto">Workspace → Agent + Work\n           ↳ one visible Work view</pre><textarea aria-label="Agent composer preview" style="position:absolute;left:24px;right:24px;bottom:18px;width:calc(100% - 48px);min-height:74px;padding:14px;border:1px solid #34363c;border-radius:10px;background:#17181b;color:#ececf0;resize:none">Ask a follow-up…</textarea></div>` },
      { id: "agent-review", title: "Review behavior", bodyHtml: `<div style="padding:38px 30px"><p>Second independently mounted Agent conversation.</p></div>` },
    ],
    workViews: [
      { key: "file:/work/apps/web/src/client/workspace-presentation.ts", label: "workspace-presentation.ts", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: `<pre style="margin:0;padding:28px;color:#c7c9d0;line-height:1.6;tab-size:2"><span style="color:#7fa8d8">interface</span> PersonalNavigationState {\n  activeAgentId?: <span style="color:#c9957c">string</span>;\n  activeWorkViewKey?: <span style="color:#c9957c">string</span>;\n  workspacePaneVisible: <span style="color:#c9957c">boolean</span>;\n  workPaneVisible: <span style="color:#c9957c">boolean</span>;\n  phoneDestination: PhoneDestination;\n}</pre>` },
      { key: "terminal:verification", label: "Verification", kind: "resource", attention: false, availability: { phase: "live" }, bodyHtml: `<pre style="height:100%;margin:0;padding:24px;background:#0b0c0e;color:#b9d19a;line-height:1.65">$ bun run test\n376 pass\n4 skip\n0 fail\n\n$ bun run lint\n1 pass\n0 fail\n<span style="color:#9699a2">█</span></pre>` },
      { key: "browser:preview", label: "Preview", kind: "resource", attention: false, availability: { phase: "opening", detail: "Opening the preserved browser preview…" }, bodyHtml: "" },
      { key: "changes", label: "Changes", kind: "contextual", attention: true, availability: { phase: "reconnecting", detail: "Refreshing the review without replacing its mounted content." }, bodyHtml: `<div style="padding:28px"><h2 style="font-size:14px">6 files changed</h2><p style="color:#9699a2">Role-fixed shell, navigation, visual foundation, and tests.</p></div>` },
    ],
  };
}
