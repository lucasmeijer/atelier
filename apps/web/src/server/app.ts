import { existsSync, readFileSync } from "node:fs";
import {
  createNextWorkspaceAgent,
  getWorkspaceAgentRuntime,
  handleAgentRequest,
  registerWorkspaceAgentTool,
  renderAgentComposer,
  type WorkspaceAgentInfo,
} from "@atelier/agent/server";
import {
  browserNavigateEndpoint,
  createOrOpenPreviewBrowserTool,
  createWorkspaceBrowserTabForWorkspace,
  deleteWorkspaceBrowserState,
  deleteWorkspaceBrowserTabForWorkspace,
} from "@atelier/browser/server";
import {
  AtelierCoreError,
  addManagedRepo,
  type AtelierEventBus,
  type WorkspaceCreationContext,
  cloneManagedRepoIntoWorkspace,
  generateWorkspaceId,
  getWorkspaceRepoMergeability,
  listManagedRepos,
  pushWorkspaceRepo,
  setWorkspaceTitle,
  type WorkspaceDeleteBlockedDetails,
  type WorkspaceRepoMergeabilityResult,
} from "@atelier/core";
import { createWorkspaceTerminal } from "@atelier/terminal/server";
import {
  createWorkspaceVSCodeTab,
  deleteWorkspaceVSCodeTab,
} from "@atelier/vscode/server";
import { atelierName, type WorkspaceAttachment, type WorkspaceCommandContribution, type WorkspaceTabContribution } from "@atelier/shared";
import type { StreamHub } from "./stream-hub.ts";
import type { WorkspaceLayoutStore } from "./workspace-layout.ts";
import type { WebPreferenceStore } from "./preferences.ts";
import type { WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceModules } from "./workspace-modules.ts";

export interface WebAppDeps {
  registry: WorkspaceRegistry;
  hub: StreamHub;
  layouts: WorkspaceLayoutStore;
  /** Event bus passed through to the agent module routes. */
  events?: AtelierEventBus;
  /** File-backed UI preferences for future/new agent creation flows. */
  preferences?: WebPreferenceStore;
  /** Create the container + default agent etc. for an already-registered workspace id. */
  provisionWorkspace(id: string, options?: { context?: WorkspaceCreationContext }): Promise<void>;
  inspectDeleteSafety(id: string): Promise<WorkspaceDeleteBlockedDetails>;
  /** Force-remove the workspace container. */
  destroyWorkspace(id: string): Promise<void>;
  /** Receives background task failures. Defaults to console.error. */
  logError?(message: string): void;
}

export interface WebApp {
  fetch(request: Request): Promise<Response>;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };

function response(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

function jsonResponse(body: unknown, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function turboStreamResponse(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/vnd.turbo-stream.html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

function turboReplaceStream(target: string, html: string): string {
  return `<turbo-stream action="replace" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

function turboRemoveStream(target: string): string {
  return `<turbo-stream action="remove" target="${escapeHtml(target)}"></turbo-stream>`;
}

/** Replaces the children of the target, keeping the container element itself alive. */
function turboUpdateStream(target: string, html: string): string {
  return `<turbo-stream action="update" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

let cachedAssetManifest: Record<string, string> | undefined;

function assetPath(logicalPath: string): string {
  if (!cachedAssetManifest) {
    const manifestUrl = new URL("../../public/assets-manifest.json", import.meta.url);
    cachedAssetManifest = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, "utf8")) as Record<string, string> : {};
  }
  return cachedAssetManifest[logicalPath] ?? logicalPath;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const { registry, hub, layouts } = deps;
  const logError = deps.logError ?? ((message: string) => console.error(message));

  registerWorkspaceAgentTool("create_or_open_preview_browser", (workspaceId, options) => createOrOpenPreviewBrowserTool(workspaceId, {
    events: options.events,
    getTabKeys: () => tabKeysFor(workspaceId),
    layouts,
  }));
  const imageBuilds = new Map<string, { state: "building" | "failed"; image: string; modules: string[]; output: string; error?: string }>();

  async function preferredNewAgentModel(): Promise<string | undefined> {
    return (await deps.preferences?.load())?.preferredNewAgentModel;
  }

  async function rememberPreferredNewAgentModel(model: string): Promise<void> {
    if (!deps.preferences || !model.trim()) return;
    const preferences = await deps.preferences.load();
    await deps.preferences.save({ ...preferences, preferredNewAgentModel: model.trim() });
  }

  async function applyPreferredNewAgentModel(agent: WorkspaceAgentInfo): Promise<void> {
    const model = await preferredNewAgentModel();
    const [provider, modelId] = String(model ?? "").split("::");
    if (!provider || !modelId) return;
    await (await getWorkspaceAgentRuntime(agent, { events: deps.events })).setModel(provider, modelId);
  }

  // ---------------------------------------------------------------------------
  // Workspace sidebar rendering. Broadcast HTML never contains per-client state
  // (no "active" classes, no selection inputs); selection is applied client-side
  // by the workspace-list Stimulus controller.
  // ---------------------------------------------------------------------------

  function workspaceRowId(id: string): string {
    return domId("workspace_row", id);
  }

  function workspaceStatusId(workspaceId: string): string {
    return domId("workspace_status", workspaceId);
  }

  function workspaceTabStatusId(workspaceId: string, tabKey: string): string {
    return domId("workspace_tab_status", workspaceId, tabKey);
  }

  function workspaceBootId(id: string): string {
    return domId("workspace_boot", id);
  }

  function renderWorkspaceStatus(workspaceId: string): string {
    return `<span id="${workspaceStatusId(workspaceId)}" class="workspace-status">${registry.isWorkspaceBusy(workspaceId) ? `<span class="status-spinner sm" aria-label="Workspace busy" title="Workspace busy"></span>` : ""}</span>`;
  }

  function renderTabStatus(workspaceId: string, tabKey: string): string {
    return `<span id="${workspaceTabStatusId(workspaceId, tabKey)}" class="tab-status">${registry.isTabBusy(workspaceId, tabKey) ? `<span class="status-spinner sm" aria-label="Tab busy" title="Tab busy"></span>` : ""}</span>`;
  }

  function workspaceTitle(entry: WorkspaceEntry): string {
    return entry.title || `Workspace ${entry.id}`;
  }

  function workspaceSidebarTitleFrame(id: string, title: string): string {
    const frameId = domId("workspace_sidebar_title", id);
    return `<turbo-frame id="${frameId}" class="workspace-row-title-frame">
    <a class="row-main" href="/workspaces/${encodeURIComponent(id)}" data-turbo="false" data-action="workspace-list#select"><div class="r-title">${escapeHtml(title)}</div></a>
    <a class="workspace-row-edit" href="/workspaces/${encodeURIComponent(id)}/sidebar-title/edit" data-turbo-frame="${frameId}" title="Rename workspace">✎</a>
  </turbo-frame>`;
  }

  function workspaceRow(entry: WorkspaceEntry): string {
    const id = entry.id;
    const title = workspaceTitle(entry);
    const selectable = entry.phase === "starting" || entry.phase === "failed" || entry.phase === "ready";
    const sourceRepoClass = entry.sourceRepoName ? "repo-tinted-row" : "";
    const sourceRepoStyle = entry.sourceRepoName ? ` style="${repoColorStyle(entry.sourceRepoName)}"` : "";
    const open = (extraClass: string) => `<div class="row workspace-row ${sourceRepoClass} ${extraClass}" id="${workspaceRowId(id)}" data-workspace-id="${escapeHtml(id)}" data-phase="${entry.phase}"${sourceRepoStyle}${selectable ? ` data-action="click->workspace-list#rowClicked"` : ""}>`;
    const workspaceLink = (label: string, attrs = "") => `<a class="row-main" href="/workspaces/${encodeURIComponent(id)}" data-turbo="false" data-action="workspace-list#select"${attrs}><div class="r-title">${escapeHtml(label)}</div></a>`;
    switch (entry.phase) {
      // All phases render single-line rows (no r-sub) so phase changes never
      // change row height.
      case "starting":
        return `${open("starting")}${renderWorkspaceStatus(id)}${workspaceLink(title, ` title="Starting workspace…"`)}<span class="row-actions"><span class="status-spinner sm" aria-label="Starting" title="Starting workspace…"></span></span></div>`;
      case "checking_delete":
      case "deleting":
        return `${open("pending-delete")}${renderWorkspaceStatus(id)}<div class="row-main" title="Deleting…"><div class="r-title">${escapeHtml(title)}</div></div><span class="row-actions"><span class="status-spinner sm" aria-label="Deleting" title="Deleting…"></span></span></div>`;
      case "failed":
        return `${open("failed")}<span class="dot err"></span>${workspaceLink(title, ` title="${escapeHtml(entry.error ?? "Workspace failed")}"`)}<form class="workspace-row-delete" method="post" action="/workspaces/${encodeURIComponent(id)}/dismiss"><button type="submit" title="${escapeHtml(entry.error ?? "Workspace failed")} — dismiss" aria-label="Dismiss">✕</button></form></div>`;
      case "ready":
        return `${open("")}${renderWorkspaceStatus(id)}${workspaceSidebarTitleFrame(id, title)}<form class="workspace-row-delete" method="post" action="/workspaces/${encodeURIComponent(id)}/delete" data-action="submit->workspace-list#deleteStarted"><button type="submit" title="Delete workspace" aria-label="Delete workspace">🗑</button></form></div>`;
    }
  }

  function renderWorkspaceRows(): string {
    const entries = registry.list();
    if (entries.length === 0) {
      return `<div class="row" id="no_workspaces_row"><span></span><div><div class="r-title">No workspaces</div><div class="r-sub">Create one below.</div></div><span></span></div>`;
    }
    return entries.map((entry) => workspaceRow(entry)).join("");
  }

  function workspaceStatusStreams(workspaceId: string): string {
    return `${turboReplaceStream(workspaceStatusId(workspaceId), renderWorkspaceStatus(workspaceId))}${registry.busyTabs(workspaceId).map((tabKey) => turboReplaceStream(workspaceTabStatusId(workspaceId, tabKey), renderTabStatus(workspaceId, tabKey))).join("")}`;
  }

  function initialStatusStreams(): string {
    return registry.list().map((entry) => workspaceStatusStreams(entry.id)).join("");
  }

  registry.setCallbacks({
    rowChanged(entry, { tabKey }) {
      if (tabKey !== undefined) {
        // Busy changes replace only the status spans so they cannot clobber an
        // in-progress title edit in the row.
        hub.broadcast(`${turboReplaceStream(workspaceStatusId(entry.id), renderWorkspaceStatus(entry.id))}${turboReplaceStream(workspaceTabStatusId(entry.id, tabKey), renderTabStatus(entry.id, tabKey))}`);
        return;
      }
      hub.broadcast(turboReplaceStream(workspaceRowId(entry.id), workspaceRow(entry)));
    },
    listChanged() {
      // "update" (not "replace"): the rows container must survive so later
      // list broadcasts still find their target.
      hub.broadcast(turboUpdateStream("workspaces_table_rows", renderWorkspaceRows()));
    },
    removed(id) {
      layouts.delete(id);
      deleteWorkspaceBrowserState(id);
      hub.broadcast(turboRemoveStream(workspaceRowId(id)));
    },
  });

  // ---------------------------------------------------------------------------
  // Page shell
  // ---------------------------------------------------------------------------

  function layout(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(atelierName)} · ${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="${assetPath("/favicon.svg")}">
<link rel="stylesheet" href="${assetPath("/style.css")}">
<link rel="stylesheet" href="${assetPath("/terminal.css")}">
<link rel="stylesheet" href="${assetPath("/agent.css")}">
<link rel="stylesheet" href="${assetPath("/vscode.css")}">
<link rel="stylesheet" href="${assetPath("/browser.css")}">
<script type="module" src="https://cdn.jsdelivr.net/npm/@hotwired/turbo@8.0.13/dist/turbo.es2017-esm.js"></script>
<script type="module">
  import { Application, Controller } from "https://cdn.jsdelivr.net/npm/@hotwired/stimulus@3.2.2/+esm";
  window.Stimulus = { Application, Controller };
</script>
<script type="module" src="${assetPath("/workspace.js")}"></script>
</head>
<body id="body">${body}
<turbo-stream-source src="/workspace-events/stream"></turbo-stream-source>
</body>
</html>`;
  }

  const repoColorPalette = [
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6",
    "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
    "#f43f5e", "#fb7185", "#fdba74", "#facc15", "#a3e635", "#4ade80", "#34d399", "#2dd4bf",
    "#22d3ee", "#38bdf8", "#60a5fa", "#818cf8", "#a78bfa", "#c084fc", "#e879f9", "#f472b6",
  ];

  function repoColor(repoName: string): string {
    let sum = 0;
    for (let i = 0; i < repoName.length; i++) sum += repoName.charCodeAt(i);
    return repoColorPalette[sum % repoColorPalette.length]!;
  }

  function repoColorStyle(repoName: string): string {
    return `--repo-color:${repoColor(repoName)}`;
  }

  function repoWorktreeName(repoName: string): string {
    return repoName.endsWith(".git") ? repoName.slice(0, -4) : repoName;
  }

  function launchRepoAgentModal(repo: { name: string; path: string; remoteUrl: string | null }, selectedModel?: string): string {
    const modalId = domId("agent_launch_repo_modal", repo.name);
    const formId = domId("agent_launch_repo_form", repo.name);
    const cloneUrl = repo.remoteUrl || repo.path;
    const worktreeName = repoWorktreeName(repo.name);
    const initialText = `git clone ${cloneUrl} into /repos/${worktreeName}\n\nand then\n\n`;
    return `<dialog id="${modalId}" class="agent-launch-modal" data-controller="modal">
  ${renderAgentComposer({
    action: `/repo-agent-workspaces/${encodeURIComponent(repo.name)}`,
    draftId: crypto.randomUUID(),
    formId,
    placeholder: "Describe what you want the agent to do…",
    initialText,
    submitLabel: "Create workspace and kick off agent",
    submitShortcut: "⌘↩",
    rows: 8,
    formActions: "turbo:submit-end->modal#submitted",
    selectedModel,
  })}
</dialog>`;
  }

  function addManagedRepoModal(): string {
    return `<dialog id="add-managed-repo-modal" class="modal" data-controller="modal">
  <form method="post" action="/managed-repos">
    <h2>Add managed repository</h2>
    <p>Create a bare clone in Atelier's data directory.</p>
    <input class="modal-input" name="gitUrl" type="text" placeholder="https://github.com/org/repo.git or /path/to/repo" required autofocus>
    <div class="modal-actions">
      <button class="btn" type="button" data-action="modal#close">Cancel</button>
      <button class="btn primary" type="submit">Add repository</button>
    </div>
  </form>
</dialog>`;
  }

  async function renderWorkspaceSidebar(): Promise<string> {
    const { repos: managedRepos } = await listManagedRepos();

    // JavaScript submits this as a Turbo Stream and then switches the resident
    // client-side. Without JavaScript, the endpoint still falls back to a 303.
    const newWorkspaceRow = `<form class="contents" method="post" action="/workspaces" data-turbo="false" data-action="submit->workspace-list#createWorkspace"><button class="row ghost-row" type="submit">
    <span></span>
    <div><div class="r-title">+ New workspace</div></div>
    <span></span>
  </button></form>`;

    const managedRepoRows = managedRepos.map((repo) => {
      const modalId = domId("agent_launch_repo_modal", repo.name);
      return `<div class="row managed-repo-row repo-tinted-row" style="${repoColorStyle(repo.name)}">
    <span></span>
    <div><div class="r-title">${escapeHtml(repo.name)}</div><div class="r-sub">${escapeHtml(repo.remoteUrl ?? repo.path)}</div></div>
    <span class="row-actions"><button class="repo-launch-btn" type="button" title="Start agent workspace from this repo" aria-label="Start agent workspace from ${escapeHtml(repo.name)}" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="${modalId}"><span aria-hidden="true">＋</span></button></span>
  </div>`;
    }).join("");

    const addManagedRepoRow = `<button class="row ghost-row" type="button" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="add-managed-repo-modal">
    <span></span>
    <div><div class="r-title">+ Add managed repository</div><div class="r-sub">Create a bare clone in the Atelier data directory</div></div>
    <span></span>
  </button>`;

    return `<turbo-frame id="workspace_sidebar" data-controller="workspace-list">
    <div class="sidebar-header">
      <h1>${escapeHtml(atelierName)}</h1>
      <div class="sidebar-filter-row">
        <input class="search global-filter" placeholder="Filter…" data-controller="global-filter" data-action="input->global-filter#filter">
      </div>
    </div>
    <div class="table workspace-sidebar-table">
      <div id="workspaces_table_rows">${renderWorkspaceRows()}</div>
      ${newWorkspaceRow}
    </div>

    <section class="host-repos sidebar-host-repos">
      <div class="section-head"><div><h2>Repositories</h2></div></div>
      <div class="table managed-repos-table">
        ${managedRepoRows || `<div class="row"><span></span><div><div class="r-title">No managed repositories</div><div class="r-sub">Add one below.</div></div><span></span></div>`}
        ${addManagedRepoRow}
      </div>
    </section>
  </turbo-frame>`;
  }

  // ---------------------------------------------------------------------------
  // Workspace detail (residency host, groups, tabs)
  // ---------------------------------------------------------------------------

  async function attachWorkspaceModules(workspaceId: string): Promise<WorkspaceAttachment[]> {
    return await Promise.all(workspaceModules.map((module) => module.attachToWorkspace({ workspaceId })));
  }

  async function workspaceTabsAndAttachments(workspaceId: string): Promise<{ attachments: WorkspaceAttachment[]; tabs: WorkspaceTabContribution[] }> {
    const attachments = await attachWorkspaceModules(workspaceId);
    return { attachments, tabs: attachments.flatMap((attachment) => attachment.tabs ?? []) };
  }

  function tabLabel(tab: WorkspaceTabContribution): string {
    return tab.label || tab.key;
  }

  function workspaceGroupsId(workspaceId: string): string {
    return domId("workspace_groups", workspaceId);
  }

  function renderTabPane(tab: WorkspaceTabContribution, active: boolean): string {
    if (!tab.paneHtml) return "";
    return tab.paneHtml.replace(/class="tab-pane([^\"]*)"/, (_match, classes: string) => {
      const classList = String(classes).replace(/\bactive\b/g, "").trim();
      return `class="tab-pane${classList ? ` ${classList}` : ""}${active ? " active" : ""}"`;
    });
  }

  function renderWorkspaceGroups(workspaceId: string, tabs: WorkspaceTabContribution[], attachments: WorkspaceAttachment[]): string {
    const layoutState = layouts.normalize(workspaceId, tabs.map((tab) => tab.key));
    const tabByKey = new Map(tabs.map((tab) => [tab.key, tab]));
    const commands = attachments.flatMap((attachment) => attachment.workspaceCommands ?? []).filter((command) => command.surfaces?.ui?.placement === "group-menu");
    const actionMenu = (group: { id: string }, index: number) => `<details class="group-add-menu"><summary class="group-icon-btn" title="Add tab or group">+</summary><div class="group-menu-panel">
      ${commands.map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.surfaces?.ui?.label ?? command.label)}</button></form>`).join("")}
      <form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/split"><button type="submit">New Group</button></form>
      ${layoutState.groups.length > 1 && index > 0 ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/close"><button type="submit">Close Group</button></form>` : ""}
    </div></details>`;
    const groups = layoutState.groups.map((group, index) => {
      const activeTab = group.activeTab && group.tabs.includes(group.activeTab) ? group.activeTab : group.tabs[0];
      const headers = group.tabs.map((key, tabIndex) => {
        const tab = tabByKey.get(key);
        if (!tab) return "";
        const label = tabLabel(tab);
        return `<div class="group-tab ${key === activeTab ? "active" : "muted"}" draggable="true" data-tab="${escapeHtml(key)}" data-action="dragstart->workspace-groups#dragStart dragend->workspace-groups#dragEnd dragover->workspace-groups#dragOver drop->workspace-groups#drop" data-group-id="${escapeHtml(group.id)}" data-tab-index="${tabIndex}"><button class="group-tab-label" data-action="click->workspace-tabs#activate" data-workspace-tabs-tab-param="${escapeHtml(key)}" type="button"><span>${escapeHtml(label)}</span>${renderTabStatus(workspaceId, key)}</button><form class="group-tab-close-form" data-turbo="true" data-controller="workspace-tab-close" data-workspace-tab-close-label-value="${escapeHtml(label)}" data-action="submit->workspace-tab-close#confirm" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(key)}/close"><button class="group-tab-close" type="submit" title="Close ${escapeHtml(label)}" aria-label="Close ${escapeHtml(label)}">×</button></form></div>`;
      }).join("");
      const panes = group.tabs.map((key) => {
        const tab = tabByKey.get(key);
        return tab ? renderTabPane(tab, key === activeTab) : "";
      }).join("");
      const empty = group.tabs.length === 0;
      return `<section class="workspace-group" data-group-id="${escapeHtml(group.id)}" data-workspace-groups-target="group" style="--group-size:${group.size}">
      <div class="group-tabbar" data-controller="workspace-tabs" data-workspace-tabs-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-tabs-group-id-value="${escapeHtml(group.id)}" data-workspace-tabs-initial-tab-value="${escapeHtml(activeTab ?? "")}" data-action="dragover->workspace-groups#dragOver drop->workspace-groups#drop">
        <div class="group-tabs">${headers}</div>${actionMenu(group, index)}
      </div>
      <div class="workspace-panes" id="${domId("workspace_panes", workspaceId, group.id)}">${empty ? `<div class="empty-group"><p>This group is empty.</p>${layoutState.groups.length > 1 ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/remove"><button class="btn sm" type="submit">Remove Empty Group</button></form>` : ""}</div>` : panes}</div>
      ${index === layoutState.groups.length - 1 ? `<div class="new-group-drop-zone" data-new-group-drop-zone="true" data-action="dragover->workspace-groups#dragOver dragleave->workspace-groups#dragLeave drop->workspace-groups#drop" title="Drop here to create a new group" aria-label="Drop tab here to create a new group"></div>` : ""}
    </section>${index < layoutState.groups.length - 1 ? `<div class="group-resizer" data-action="pointerdown->workspace-groups#startResize" data-resizer-index="${index}" role="separator" aria-orientation="vertical"></div>` : ""}`;
    }).join("");
    return `<div class="workspace-groups" id="${workspaceGroupsId(workspaceId)}" data-controller="workspace-groups" data-workspace-groups-workspace-id-value="${escapeHtml(workspaceId)}">${groups}</div>`;
  }

  async function renderWorkspaceGroupsFor(workspaceId: string): Promise<string> {
    const { attachments, tabs } = await workspaceTabsAndAttachments(workspaceId);
    return renderWorkspaceGroups(workspaceId, tabs, attachments);
  }

  async function workspaceDetailContent(id: string): Promise<string> {
    const { attachments, tabs } = await workspaceTabsAndAttachments(id);
    return `<div class="main workspace-detail-main" data-workspace-id="${escapeHtml(id)}">
    <div class="body wide workspace-body">
      ${renderWorkspaceGroups(id, tabs, attachments)}
    </div>
</div>`;
  }

  async function workspaceDetailResidentHtml(id: string, options: { active?: boolean } = {}): Promise<string> {
    return `<div class="workspace-detail-resident ${options.active ? "active" : ""}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(id)}">${await workspaceDetailContent(id)}</div>`;
  }

  function workspaceImageBuildHtml(id: string): string {
    const build = imageBuilds.get(id);
    if (!build) return "";
    const heading = build.state === "failed" ? "Workspace image build failed" : "Building workspace image…";
    const detail = build.state === "failed"
      ? escapeHtml(build.error ?? "Docker build failed")
      : "This is the first workspace using this image configuration, so it can take a few minutes.";
    return `<div class="workspace-build-status ${build.state}">
      <div class="workspace-build-heading"><div><b>${heading}</b><div class="r-sub">${detail}</div></div></div>
      <div class="r-sub">Image: <code>${escapeHtml(build.image)}</code>${build.modules.length ? ` · Modules: ${escapeHtml(build.modules.join(", "))}` : ""}</div>
      ${build.output ? `<pre class="workspace-build-log" data-controller="workspace-build-log">${escapeHtml(build.output)}</pre>` : `<div class="workspace-build-log empty">Waiting for Docker build output…</div>`}
    </div>`;
  }

  function workspaceBootResidentHtml(entry: WorkspaceEntry, options: { active?: boolean } = {}): string {
    const buildHtml = imageBuilds.get(entry.id) ? workspaceImageBuildHtml(entry.id) : "";
    const inner = entry.phase === "failed"
      ? buildHtml || `<div class="pad workspace-boot-pad"><span class="dot err"></span> Workspace creation failed: ${escapeHtml(entry.error ?? "unknown error")}</div>`
      : buildHtml || `<div class="pad workspace-boot-pad"><span class="status-spinner"></span> Starting workspace…</div>`;
    return `<div class="workspace-detail-resident workspace-boot ${options.active ? "active" : ""}" id="${workspaceBootId(entry.id)}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(entry.id)}"><div class="main"><header class="header"><h1>${escapeHtml(workspaceTitle(entry))}</h1></header><div class="body"><div class="panel">${inner}</div></div></div></div>`;
  }

  function broadcastWorkspaceBoot(id: string): void {
    const entry = registry.get(id);
    if (!entry || (entry.phase !== "starting" && entry.phase !== "failed")) return;
    hub.broadcast(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
  }

  deps.events?.on("workspace_image_build_started", (event) => {
    imageBuilds.set(event.workspaceId, { state: "building", image: event.image, modules: event.modules, output: event.output });
    broadcastWorkspaceBoot(event.workspaceId);
  });

  deps.events?.on("workspace_image_build_output", (event) => {
    imageBuilds.set(event.workspaceId, { state: "building", image: event.image, modules: event.modules, output: event.output });
    broadcastWorkspaceBoot(event.workspaceId);
  });

  deps.events?.on("workspace_image_build_finished", (event) => {
    if (event.error) {
      imageBuilds.set(event.workspaceId, { state: "failed", image: event.image, modules: event.modules, output: event.output, error: event.error });
    } else {
      imageBuilds.delete(event.workspaceId);
    }
    broadcastWorkspaceBoot(event.workspaceId);
  });

  async function workspaceResidentFor(entry: WorkspaceEntry, options: { active?: boolean } = {}): Promise<string> {
    if (entry.phase === "starting" || entry.phase === "failed") return workspaceBootResidentHtml(entry, options);
    return await workspaceDetailResidentHtml(entry.id, options);
  }

  async function workspaceDetailHostHtml(selectedId?: string): Promise<string> {
    const entry = selectedId ? registry.get(selectedId) : undefined;
    const resident = entry ? await workspaceResidentFor(entry, { active: true }) : "";
    return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-residency" data-workspace-residency-max-resident-value="10">
      <div class="workspace-detail-empty" data-workspace-residency-target="empty"${resident ? " hidden" : ""}><div class="main"><header class="header"><h1>Select a workspace</h1></header><div class="body"><div class="panel"><div class="pad">Create or select a workspace to begin.</div></div></div></div></div>
      <div class="workspace-detail-loading" data-workspace-residency-target="loading" hidden><div class="main"><div class="body"><div class="panel"><div class="pad workspace-boot-pad"><span class="status-spinner"></span> Loading workspace…</div></div></div></div></div>
      ${resident}
    </div>`;
  }

  async function renderRepoLaunchModals(): Promise<string> {
    const { repos } = await listManagedRepos();
    const selectedModel = await preferredNewAgentModel();
    return repos.map((repo) => launchRepoAgentModal(repo, selectedModel)).join("");
  }

  async function renderWorkspaceShell(selectedId?: string): Promise<string> {
    return `<div class="app workspace-shell" data-controller="workspace-shell atelier-shortcuts">
    <aside class="workspace-shell-sidebar" data-workspace-shell-target="sidebar">${await renderWorkspaceSidebar()}</aside>
    <div class="workspace-shell-rail" title="Resize workspace list" data-action="pointerdown->workspace-shell#startResize">
      <button class="sidebar-collapse-notch" type="button" aria-label="Collapse workspace list" title="Collapse workspace list" data-workspace-shell-target="toggle" data-action="pointerdown->workspace-shell#stopPropagation click->workspace-shell#toggle">‹</button>
    </div>
    <main class="workspace-shell-main">${await workspaceDetailHostHtml(selectedId)}</main>
  </div>
  ${addManagedRepoModal()}
  ${await renderRepoLaunchModals()}`;
  }

  async function homePage(): Promise<Response> {
    const selected = registry.list().find((entry) => entry.phase !== "failed");
    return response(layout("Workspaces", await renderWorkspaceShell(selected?.id)));
  }

  function requireWorkspace(id: string): WorkspaceEntry {
    const entry = registry.get(id);
    if (!entry) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
    return entry;
  }

  async function workspacePage(id: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    const url = new URL(request.url);
    if (url.searchParams.get("resident") === "1") return response(await workspaceResidentFor(entry, { active: true }));
    return response(layout(workspaceTitle(entry), await renderWorkspaceShell(id)));
  }

  // ---------------------------------------------------------------------------
  // Create / delete / dismiss
  // ---------------------------------------------------------------------------

  function startWorkspaceProvisioning(id: string, options: { context?: WorkspaceCreationContext } = {}): void {
    void (async () => {
      try {
        await deps.provisionWorkspace(id, { context: options.context });
        registry.setPhase(id, "ready");
        await broadcastWorkspaceReady(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`could not provision workspace ${id}: ${message}`);
        registry.setPhase(id, "failed", message);
        const entry = registry.get(id);
        // No "active" class in broadcasts: each client activates the resident
        // itself iff it is currently looking at this workspace.
        if (entry) hub.broadcast(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
      }
    })();
  }

  function createWorkspaceEndpoint(url: URL, request: Request): Response {
    const id = generateWorkspaceId();
    registry.add(id);
    startWorkspaceProvisioning(id);
    const location = new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString();
    if (wantsTurboStream(request)) {
      return turboStreamResponse(turboUpdateStream("workspaces_table_rows", renderWorkspaceRows()), { headers: { location } });
    }
    return Response.redirect(location, 303);
  }

  async function createRepoAgentWorkspaceEndpoint(repoName: string, request: Request): Promise<Response> {
    const { repos } = await listManagedRepos();
    const repo = repos.find((candidate) => candidate.name === repoName);
    if (!repo) throw new AtelierCoreError("managed_repo_not_found", `managed repo not found: ${repoName}`);
    const form = await request.formData();
    const text = String(form.get("text") ?? "").trim();
    if (!text) return turboStreamResponse("", { status: 400 });
    const id = generateWorkspaceId();
    registry.add(id, null, repo.name);
    const model = String(form.get("model") ?? "");
    await rememberPreferredNewAgentModel(model);
    const context: WorkspaceCreationContext = {
      sourceRepoName: repo.name,
      agent: {
        initialPrompt: text,
        model,
        thinkingLevel: String(form.get("level") ?? ""),
        attachmentDraft: String(form.get("attachmentDraft") ?? ""),
      },
    };
    startWorkspaceProvisioning(id, { context });
    return turboStreamResponse(turboUpdateStream("workspaces_table_rows", renderWorkspaceRows()));
  }

  async function broadcastWorkspaceReady(id: string): Promise<void> {
    try {
      // No "active" class in broadcasts: each client activates the resident
      // itself iff it is currently looking at this workspace.
      hub.broadcast(turboReplaceStream(workspaceBootId(id), await workspaceDetailResidentHtml(id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`could not render workspace detail for ${id}: ${message}`);
    }
  }

  function deleteBlockedModal(id: string, details: WorkspaceDeleteBlockedDetails): string {
    const issues = details.issues ?? [];
    const issueHtml = issues.map((issue) => {
      return `<section class="delete-issue"><h3>${escapeHtml(issue.repo ?? "unknown repo")}</h3>
      ${issue.uncommittedPaths.length > 0 ? `<h4>Uncommitted/staged paths</h4><ul>${issue.uncommittedPaths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}</ul>` : ""}
      ${issue.outgoingCommits.length > 0 ? `<h4>Unpushed commits</h4><ul>${issue.outgoingCommits.map((commit) => `<li><code>${escapeHtml(String(commit.hash ?? "").slice(0, 12))}</code> ${escapeHtml(commit.subject ?? "")}</li>`).join("")}</ul>` : ""}
    </section>`;
    }).join("");
    return `<dialog id="delete-workspace-modal" class="modal delete-modal" data-controller="modal" data-modal-auto-show-value="true">
    <form method="dialog"><h2>Workspace has uncommitted changes</h2><p>Deleting this workspace would discard local changes or commits that have not been pushed.</p>${issueHtml}<div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn danger" value="force" form="force-delete-workspace-form">Force delete</button></div></form>
    <form id="force-delete-workspace-form" method="post" action="/workspaces/${encodeURIComponent(id)}/delete?force=1"></form>
  </dialog>`;
  }

  async function deleteWorkspaceEndpoint(id: string, force: boolean): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.phase !== "ready") {
      // Already starting/deleting/failed: nothing sensible to do.
      return turboStreamResponse(turboRemoveStream("delete-workspace-modal"), { status: 409 });
    }
    registry.setPhase(id, "checking_delete");
    if (!force) {
      let details: WorkspaceDeleteBlockedDetails;
      try {
        details = await deps.inspectDeleteSafety(id);
      } catch (error) {
        registry.setPhase(id, "ready");
        throw error;
      }
      if (details.issues.length > 0) {
        registry.setPhase(id, "ready");
        return turboStreamResponse(`${turboRemoveStream("delete-workspace-modal")}<turbo-stream action="append" target="body"><template>${deleteBlockedModal(id, details)}</template></turbo-stream>`);
      }
    }
    registry.setPhase(id, "deleting");
    void (async () => {
      try {
        await deps.destroyWorkspace(id);
        registry.remove(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`could not delete workspace ${id}: ${message}`);
        registry.setPhase(id, "failed", `Delete failed: ${message}`);
      }
    })();
    return turboStreamResponse(turboRemoveStream("delete-workspace-modal"));
  }

  function dismissWorkspaceEndpoint(id: string): Response {
    const entry = registry.get(id);
    if (entry?.phase === "failed") registry.remove(id);
    return turboStreamResponse("");
  }

  // ---------------------------------------------------------------------------
  // Titles
  // ---------------------------------------------------------------------------

  function workspaceSidebarTitleEditFrame(id: string): Response {
    const entry = requireWorkspace(id);
    const frameId = domId("workspace_sidebar_title", id);
    return response(`<turbo-frame id="${frameId}" class="workspace-row-title-frame">
    <form class="workspace-sidebar-title-form" method="post" action="/workspaces/${encodeURIComponent(id)}/sidebar-title" data-controller="workspace-title-edit" data-workspace-title-edit-cancel-url-value="/workspaces/${encodeURIComponent(id)}/sidebar-title" data-action="keydown->workspace-title-edit#keydown">
      <input name="title" value="${escapeHtml(workspaceTitle(entry))}" aria-label="Workspace title" autofocus>
    </form>
  </turbo-frame>`);
  }

  function workspaceSidebarTitleShowFrame(id: string): Response {
    const entry = requireWorkspace(id);
    return response(workspaceSidebarTitleFrame(id, workspaceTitle(entry)));
  }

  async function updateWorkspaceSidebarTitleFromForm(id: string, request: Request): Promise<Response> {
    requireWorkspace(id);
    const formData = await request.formData();
    const title = String(formData.get("title") ?? "").trim();
    await setWorkspaceTitle(id, title);
    registry.setTitle(id, title || null);
    return response(workspaceSidebarTitleFrame(id, title || `Workspace ${id}`));
  }

  // ---------------------------------------------------------------------------
  // Managed repos / mergeability / push (unchanged behavior)
  // ---------------------------------------------------------------------------

  async function createManagedRepoFromForm(request: Request, url: URL): Promise<Response> {
    const formData = await request.formData();
    const gitUrl = String(formData.get("gitUrl") ?? "");
    await addManagedRepo(gitUrl);
    return Response.redirect(new URL("/", url).toString(), 303);
  }

  async function cloneManagedRepoIntoWorkspaceFromForm(id: string, request: Request, url: URL): Promise<Response> {
    const formData = await request.formData();
    const repo = String(formData.get("repo") ?? "");
    await cloneManagedRepoIntoWorkspace(id, repo);
    return Response.redirect(new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString(), 303);
  }

  function statusBadge(className: string, label: string, title: string): string {
    return `<span class="git-status-badge ${className}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  }

  function commitBadges(result: WorkspaceRepoMergeabilityResult): string[] {
    const badges: string[] = [];
    if ("ahead" in result && result.ahead > 0) badges.push(statusBadge("ahead", `↑${result.ahead}`, `${result.ahead} commits ahead`));
    if ("behind" in result && result.behind > 0) badges.push(statusBadge("behind", `↓${result.behind}`, `${result.behind} commits behind`));
    return badges;
  }

  function workingTreeBadges(result: WorkspaceRepoMergeabilityResult): string[] {
    return [
      result.workingTree.addedFiles.length > 0 ? statusBadge("added", `+${result.workingTree.addedFiles.length}`, `${result.workingTree.addedFiles.length} added files`) : "",
      result.workingTree.removedFiles.length > 0 ? statusBadge("removed", `-${result.workingTree.removedFiles.length}`, `${result.workingTree.removedFiles.length} removed files`) : "",
      result.workingTree.modifiedFiles.length > 0 ? statusBadge("modified", `~${result.workingTree.modifiedFiles.length}`, `${result.workingTree.modifiedFiles.length} modified files`) : "",
      result.workingTree.untrackedFiles.length > 0 ? statusBadge("untracked", `?${result.workingTree.untrackedFiles.length}`, `${result.workingTree.untrackedFiles.length} untracked files`) : "",
    ].filter(Boolean);
  }

  function repoStatusBadges(result: WorkspaceRepoMergeabilityResult): string {
    const badges = result.state === "has_conflicts"
      ? [...commitBadges(result), statusBadge("conflict", `⚠${result.conflictCount}`, `${result.conflictCount} conflicts`)]
      : result.state === "fetch_failed"
        ? [statusBadge("conflict", "fetch failed", "Could not fetch upstream"), ...workingTreeBadges(result)]
        : [...commitBadges(result), ...workingTreeBadges(result)];
    return badges.length > 0 ? `<span class="git-status-badges">${badges.join("")}</span>` : `<small>clean</small>`;
  }

  function mergeabilityRow(id: string, repo: string, result: WorkspaceRepoMergeabilityResult): string {
    const name = escapeHtml(repo);
    switch (result.state) {
      case "can_push":
        return `<div class="git-status-row clean"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b>${repoStatusBadges(result)}</div><form method="post" action="/workspaces/${encodeURIComponent(id)}/repos/${encodeURIComponent(repo)}/push"><button class="btn primary sm" type="submit">Push to atelier</button></form></div>`;
      case "has_conflicts":
        return `<div class="git-status-row rebase"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b>${repoStatusBadges(result)}</div><button class="btn sm fix-rebase" type="button" disabled>Ask agent to rebase</button></div>`;
      case "fetch_failed":
        return `<div class="git-status-row fetch-failed"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b>${repoStatusBadges(result)}</div><button class="btn sm" type="button" disabled>Retry fetch</button></div>`;
      case "nothing_to_push":
        return `<div class="git-status-row idle"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b>${repoStatusBadges(result)}</div></div>`;
    }
    const exhaustive: never = result;
    return exhaustive;
  }

  async function mergeabilityFrame(id: string, repo: string): Promise<Response> {
    const frameId = domId("repo_mergeability", id, repo);
    try {
      const result = await getWorkspaceRepoMergeability(id, repo);
      return response(`<turbo-frame id="${frameId}">${mergeabilityRow(id, repo, result)}</turbo-frame>`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response(`<turbo-frame id="${frameId}"><div class="git-status-row fetch-failed"><div class="repo-identity"><span class="repo-dot"></span><b>${escapeHtml(repo)}</b><small title="${escapeHtml(message)}">Could not check mergeability.</small></div><button class="btn sm" type="button" disabled>Retry fetch</button></div></turbo-frame>`);
    }
  }

  function wantsTurboStream(request: Request): boolean {
    return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
  }

  async function pushRepoEndpoint(id: string, repo: string, request: Request): Promise<Response> {
    const frameId = domId("repo_mergeability", id, repo);
    try {
      const pushed = await pushWorkspaceRepo(id, repo);
      if (pushed.state === "failed") {
        return response(`<turbo-frame id="${frameId}"><div class="git-status-row fetch-failed"><div class="repo-identity"><span class="repo-dot"></span><b>${escapeHtml(repo)}</b><small title="${escapeHtml(pushed.message)}">Push failed.</small></div><button class="btn sm" type="button" disabled>Retry fetch</button></div></turbo-frame>`, { status: 500 });
      }
      const result = await getWorkspaceRepoMergeability(id, repo);
      const body = `<turbo-frame id="${frameId}">${mergeabilityRow(id, repo, result)}</turbo-frame>`;
      if (wantsTurboStream(request)) return turboStreamResponse(`<turbo-stream action="replace" target="${frameId}"><template>${body}</template></turbo-stream>`);
      return response(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response(`<turbo-frame id="${frameId}"><div class="git-status-row fetch-failed"><div class="repo-identity"><span class="repo-dot"></span><b>${escapeHtml(repo)}</b><small title="${escapeHtml(message)}">Push failed.</small></div><button class="btn sm" type="button" disabled>Retry fetch</button></div></turbo-frame>`, { status: 500 });
    }
  }

  // ---------------------------------------------------------------------------
  // Group / tab layout endpoints (requester-only streams; no cross-user sync)
  // ---------------------------------------------------------------------------

  async function replaceWorkspaceGroupsTurboStream(workspaceId: string): Promise<string> {
    return `<turbo-stream action="replace" target="${workspaceGroupsId(workspaceId)}"><template>${await renderWorkspaceGroupsFor(workspaceId)}</template></turbo-stream>`;
  }

  async function replaceWorkspaceGroupsStream(workspaceId: string): Promise<Response> {
    return turboStreamResponse(await replaceWorkspaceGroupsTurboStream(workspaceId));
  }

  async function tabKeysFor(workspaceId: string): Promise<string[]> {
    return (await workspaceTabsAndAttachments(workspaceId)).tabs.map((tab) => tab.key);
  }

  async function splitWorkspaceGroupEndpoint(workspaceId: string, groupId: string): Promise<Response> {
    layouts.splitGroup(workspaceId, await tabKeysFor(workspaceId), groupId);
    return replaceWorkspaceGroupsStream(workspaceId);
  }

  async function removeWorkspaceGroupEndpoint(workspaceId: string, groupId: string): Promise<Response> {
    layouts.removeEmptyGroup(workspaceId, await tabKeysFor(workspaceId), groupId);
    return replaceWorkspaceGroupsStream(workspaceId);
  }

  async function closeWorkspaceGroupEndpoint(workspaceId: string, groupId: string): Promise<Response> {
    layouts.closeGroup(workspaceId, await tabKeysFor(workspaceId), groupId);
    return replaceWorkspaceGroupsStream(workspaceId);
  }

  async function assertWorkspaceCommandExists(workspaceId: string, commandId: string): Promise<void> {
    const commands = (await workspaceTabsAndAttachments(workspaceId)).attachments.flatMap((attachment) => attachment.workspaceCommands ?? []);
    if (!commands.some((command: WorkspaceCommandContribution) => command.id === commandId)) {
      throw new AtelierCoreError("command_not_found", `workspace command not found: ${commandId}`);
    }
  }

  async function executeWorkspaceCommand(workspaceId: string, commandId: string, context: { groupId?: string } = {}): Promise<{ createdTabKey?: string }> {
    await assertWorkspaceCommandExists(workspaceId, commandId);
    switch (commandId) {
      case "agent.create": {
        const agent = await createNextWorkspaceAgent(workspaceId);
        await applyPreferredNewAgentModel(agent);
        return { createdTabKey: `agent:${agent.label}` };
      }
      case "terminal.create":
        return { createdTabKey: `terminal:${(await createWorkspaceTerminal(workspaceId)).title}` };
      case "vscode.open": {
        const existing = (await tabKeysFor(workspaceId)).find((key) => key.startsWith("vscode:"));
        return { createdTabKey: existing ?? `vscode:${createWorkspaceVSCodeTab(workspaceId).title}` };
      }
      case "browser.create":
        return { createdTabKey: createWorkspaceBrowserTabForWorkspace(workspaceId).key };
      default:
        throw new AtelierCoreError("command_not_implemented", `workspace command not implemented: ${commandId}`);
    }
  }

  async function workspaceGroupCommandEndpoint(workspaceId: string, groupId: string, commandId: string): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId, { groupId });
    const { attachments, tabs } = await workspaceTabsAndAttachments(workspaceId);
    if (result.createdTabKey) layouts.placeNewTab(workspaceId, tabs.map((tab) => tab.key), groupId, result.createdTabKey);
    return turboStreamResponse(`<turbo-stream action="replace" target="${workspaceGroupsId(workspaceId)}"><template>${renderWorkspaceGroups(workspaceId, tabs, attachments)}</template></turbo-stream>`);
  }

  async function workspaceGroupActionEndpoint(workspaceId: string, groupId: string, actionKey: string): Promise<Response> {
    const legacyCommandId = new Map([
      ["agent:create", "agent.create"],
      ["terminal:create", "terminal.create"],
      ["vscode:create", "vscode.open"],
      ["browser:create", "browser.create"],
    ]).get(actionKey);
    if (!legacyCommandId) throw new AtelierCoreError("command_not_found", `workspace action not found: ${actionKey}`);
    return await workspaceGroupCommandEndpoint(workspaceId, groupId, legacyCommandId);
  }

  async function closeWorkspaceTabEndpoint(workspaceId: string, tab: string): Promise<Response> {
    if (tab.startsWith("vscode:")) deleteWorkspaceVSCodeTab(workspaceId, tab.slice("vscode:".length));
    if (/^browser-\d+$/.test(tab)) deleteWorkspaceBrowserTabForWorkspace(workspaceId, tab);
    layouts.closeTab(workspaceId, await tabKeysFor(workspaceId), tab);
    return replaceWorkspaceGroupsStream(workspaceId);
  }

  async function moveWorkspaceTabEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as { tab?: unknown; toGroup?: unknown; toIndex?: unknown; newGroup?: unknown } | undefined;
    const tab = typeof body?.tab === "string" ? body.tab : "";
    if (tab) {
      layouts.moveTab(workspaceId, await tabKeysFor(workspaceId), {
        tab,
        toGroup: typeof body?.toGroup === "string" ? body.toGroup : undefined,
        toIndex: typeof body?.toIndex === "number" && Number.isFinite(body.toIndex) ? body.toIndex : undefined,
        newGroup: body?.newGroup === true,
      });
    }
    return replaceWorkspaceGroupsStream(workspaceId);
  }


  async function resizeWorkspaceGroupsEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as { sizes?: unknown } | undefined;
    const sizes = Array.isArray(body?.sizes) ? body.sizes.map(Number).filter((size) => Number.isFinite(size) && size > 0) : [];
    layouts.resize(workspaceId, await tabKeysFor(workspaceId), sizes);
    return jsonResponse({ ok: true });
  }

  async function updateWorkspaceViewStateEndpoint(id: string, request: Request): Promise<Response> {
    const body = await request.json().catch(() => undefined) as { activeTab?: unknown; groupId?: unknown } | undefined;
    const activeTab = typeof body?.activeTab === "string" ? body.activeTab : undefined;
    const groupId = typeof body?.groupId === "string" ? body.groupId : undefined;
    if (activeTab && groupId) layouts.setActiveTab(id, groupId, activeTab);
    return jsonResponse({ ok: true });
  }

  deps.events?.on("workspace_tabs_changed", ({ workspaceId }) => {
    void replaceWorkspaceGroupsTurboStream(workspaceId)
      .then((html) => hub.broadcast(html))
      .catch((error) => logError(`could not broadcast workspace tab changes for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`));
  });

  // ---------------------------------------------------------------------------
  // Errors + routing
  // ---------------------------------------------------------------------------

  function errorPage(error: unknown): Response {
    const status = error instanceof AtelierCoreError && ["workspace_not_found", "repo_not_found", "terminal_not_found", "agent_not_found"].includes(error.code) ? 404 : 500;
    const message = error instanceof Error ? error.message : String(error);
    return response(layout("Error", `<div class="app no-sidebar"><div class="main"><header class="header"><h1>Error</h1></header><div class="body"><p>${escapeHtml(message)}</p><p><a class="btn" href="/">Back home</a></p></div></div></div>`), { status });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/up" && request.method === "GET") return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    if (url.pathname === "/" && request.method === "GET") return await homePage();
    if (url.pathname === "/workspace-events/stream" && request.method === "GET") return hub.sseResponse(initialStatusStreams);
    if (url.pathname === "/workspaces" && request.method === "GET") return Response.redirect(new URL("/", url).toString(), 302);
    if (url.pathname === "/workspaces" && request.method === "POST") return createWorkspaceEndpoint(url, request);
    if (url.pathname === "/managed-repos" && request.method === "POST") return await createManagedRepoFromForm(request, url);

    const match = (pattern: RegExp): string[] | undefined => {
      const result = url.pathname.match(pattern);
      return result ? result.slice(1).map(decodeURIComponent) : undefined;
    };

    const agentResponse = await handleAgentRequest(request, url, { events: deps.events });
    if (agentResponse) return agentResponse;

    let params: string[] | undefined;

    if ((params = match(/^\/repo-agent-workspaces\/([^/]+)$/)) && request.method === "POST") return await createRepoAgentWorkspaceEndpoint(params[0], request);

    if ((params = match(/^\/workspaces\/([^/]+)\/sidebar-title\/edit$/)) && request.method === "GET") return workspaceSidebarTitleEditFrame(params[0]);
    if ((params = match(/^\/workspaces\/([^/]+)\/sidebar-title$/))) {
      if (request.method === "GET") return workspaceSidebarTitleShowFrame(params[0]);
      if (request.method === "POST") return await updateWorkspaceSidebarTitleFromForm(params[0], request);
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/view-state$/)) && request.method === "POST") return await updateWorkspaceViewStateEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") return await workspaceGroupCommandEndpoint(params[0], params[1], params[2]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/actions\/([^/]+)$/)) && request.method === "POST") return await workspaceGroupActionEndpoint(params[0], params[1], params[2]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/split$/)) && request.method === "POST") return await splitWorkspaceGroupEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/remove$/)) && request.method === "POST") return await removeWorkspaceGroupEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/close$/)) && request.method === "POST") return await closeWorkspaceGroupEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/close$/)) && request.method === "POST") return await closeWorkspaceTabEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/layout\/move-tab$/)) && request.method === "POST") return await moveWorkspaceTabEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/tabs\/(.+)\/close$/)) && request.method === "POST") return await closeWorkspaceTabEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/layout\/resize$/)) && request.method === "POST") return await resizeWorkspaceGroupsEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/browser\/navigate$/)) && request.method === "POST") return await browserNavigateEndpoint(params[0], "browser", request);
    if ((params = match(/^\/workspaces\/([^/]+)\/browser\/([^/]+)\/navigate$/)) && request.method === "POST") return await browserNavigateEndpoint(params[0], params[1], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/clone-managed-repo$/)) && request.method === "POST") return await cloneManagedRepoIntoWorkspaceFromForm(params[0], request, url);
    if ((params = match(/^\/workspaces\/([^/]+)\/repos\/([^/]+)\/push$/)) && request.method === "POST") return await pushRepoEndpoint(params[0], params[1], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/repos\/([^/]+)\/mergeability$/)) && request.method === "GET") return await mergeabilityFrame(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteWorkspaceEndpoint(params[0], url.searchParams.get("force") === "1");
    if ((params = match(/^\/workspaces\/([^/]+)\/dismiss$/)) && request.method === "POST") return dismissWorkspaceEndpoint(params[0]);
    if ((params = match(/^\/workspaces\/([^/]+)$/)) && request.method === "GET") return await workspacePage(params[0], request);

    return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return {
    async fetch(request) {
      try {
        return await route(request);
      } catch (error) {
        return errorPage(error);
      }
    },
  };
}
