import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  createNextWorkspaceAgent,
  getWorkspaceAgentRuntime,
  createDeleteCurrentWorkspaceTool,
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
  discoverHostGitHubToken,
  hasWorkspaceGitHubToken,
  type AtelierEventBus,
  type WorkspaceCreationContext,
} from "@atelier/core";
import { desktopTabKey, ensureWorkspaceDesktop } from "@atelier/desktop/server";
import {
  addRepository,
  formatRepositorySpec,
  getWorkspaceRepoMergeability,
  listRepositories,
  pushWorkspaceRepo,
  type RepositorySummary,
  type WorkspaceDeleteBlockedDetails,
  type WorkspaceRepoMergeabilityResult,
} from "@atelier/repository";
import { generateWorkspaceId, listWorkspaces, setWorkspaceTitle } from "@atelier/workspace";
import { createWorkspaceProvisioningStore } from "@atelier/workspace/server/provisioning";
import { createWorkspaceTerminal } from "@atelier/workspace-terminal/server";
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
import { handleSettingsRequest, renderSettingsDialog } from "./settings/routes.ts";
import { handleOnboardingRequest, renderOnboardingDialogIfNeeded } from "./onboarding/routes.ts";
import { getConfiguredAgentModels, setActiveAgentModel } from "@atelier/agent/server";

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
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(body, { ...init, headers });
}

function jsonResponse(body: unknown, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function turboStreamResponse(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/vnd.turbo-stream.html; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
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

function envString(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function gitOutput(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function atelierVersionTooltip(): string {
  const commitId = envString("ATELIER_COMMIT_ID", "ATELIER_COMMIT_SHA", "GIT_COMMIT", "SOURCE_VERSION") ?? gitOutput(["rev-parse", "HEAD"]);
  const description = envString("ATELIER_COMMIT_DESCRIPTION", "ATELIER_COMMIT_SUBJECT", "GIT_COMMIT_MESSAGE") ?? gitOutput(["log", "-1", "--pretty=%s"]);
  if (commitId && description) return `${commitId} ${description}`;
  if (commitId) return commitId;
  return "Version information unavailable";
}

let cachedAssetManifest: Record<string, string> | undefined;

function loadAssetManifest(): Record<string, string> {
  const manifestUrl = new URL("../../public/assets-manifest.json", import.meta.url);
  return existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, "utf8")) as Record<string, string> : {};
}

function publicAssetExists(path: string): boolean {
  return existsSync(new URL(`../../public/${path.replace(/^\//, "")}`, import.meta.url));
}

function assetPath(logicalPath: string): string {
  cachedAssetManifest ??= loadAssetManifest();
  let resolved = cachedAssetManifest[logicalPath] ?? logicalPath;
  // In development, build:client can rewrite hashed assets while the server is
  // still running. If the cached manifest now points at a deleted file, reload
  // it so pages do not render stale /assets/*.js URLs that leave the app without
  // its workspace controllers.
  if (resolved.startsWith("/assets/") && !publicAssetExists(resolved)) {
    cachedAssetManifest = loadAssetManifest();
    resolved = cachedAssetManifest[logicalPath] ?? logicalPath;
  }
  return resolved;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const { registry, hub, layouts } = deps;
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const versionTooltip = atelierVersionTooltip();

  registerWorkspaceAgentTool("create_or_open_preview_browser", (workspaceId, options) => createOrOpenPreviewBrowserTool(workspaceId, {
    events: options.events,
    getTabKeys: () => tabKeysFor(workspaceId),
    layouts,
  }));
  registerWorkspaceAgentTool("delete_current_workspace", (workspaceId) => createDeleteCurrentWorkspaceTool(workspaceId, (force) => deleteCurrentWorkspaceFromAgent(workspaceId, force)));
  const provisioning = createWorkspaceProvisioningStore({ onChange: (workspaceId) => broadcastWorkspaceBoot(workspaceId) });
  const workspaceCommandModalHostId = "workspace_command_modal_host";

  async function preferredNewAgentModel(): Promise<string | undefined> {
    const configuredModels = await getConfiguredAgentModels();
    const active = configuredModels.find((model) => model.active) ?? configuredModels[0];
    return active ? `${active.provider}::${active.id}` : undefined;
  }

  async function rememberPreferredNewAgentModel(model: string): Promise<void> {
    const [provider, modelId] = String(model ?? "").split("::");
    if (provider && modelId) await setActiveAgentModel(provider, modelId);
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
    return entry.title || entry.sourceRepositoryName || `Workspace ${entry.id}`;
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
    const sourceRepositoryClass = entry.sourceRepositoryId ? "repo-tinted-row" : "";
    const sourceRepositoryStyle = entry.sourceRepositoryId ? ` style="${repoColorStyle(entry.sourceRepositoryId)}"` : "";
    const open = (extraClass: string) => `<div class="row workspace-row ${sourceRepositoryClass} ${extraClass}" id="${workspaceRowId(id)}" data-workspace-id="${escapeHtml(id)}" data-phase="${entry.phase}"${sourceRepositoryStyle}${selectable ? ` data-action="click->workspace-list#rowClicked"` : ""}>`;
    const workspaceLink = (label: string, attrs = "") => `<a class="row-main" href="/workspaces/${encodeURIComponent(id)}" data-turbo="false" data-action="workspace-list#select"${attrs}><div class="r-title">${escapeHtml(label)}</div></a>`;
    switch (entry.phase) {
      // All phases render single-line rows (no r-sub) so phase changes never
      // change row height.
      case "starting":
        return `${open("starting")}${workspaceLink(title, ` title="Preparing workspace…"`)}<span class="row-actions"><span class="status-spinner sm" aria-label="Preparing" title="Preparing workspace…"></span></span></div>`;
      case "checking_delete":
      case "deleting":
        return `${open("pending-delete")}<div class="row-main" title="Deleting…"><div class="r-title">${escapeHtml(title)}</div></div><span class="row-actions"><span class="status-spinner sm" aria-label="Deleting" title="Deleting…"></span></span></div>`;
      case "failed":
        return `${open("failed")}${workspaceLink(title, ` title="${escapeHtml(entry.error ?? "Workspace failed")}"`)}<form class="workspace-row-delete" method="post" action="/workspaces/${encodeURIComponent(id)}/dismiss"><button type="submit" title="${escapeHtml(entry.error ?? "Workspace failed")} — dismiss" aria-label="Dismiss">✕</button></form></div>`;
      case "ready":
        return `${open("")}${workspaceSidebarTitleFrame(id, title)}<div class="workspace-row-actions">${renderWorkspaceStatus(id)}<form class="workspace-row-delete" method="post" action="/workspaces/${encodeURIComponent(id)}/delete" data-action="submit->workspace-list#deleteStarted"><button type="submit" title="Delete workspace" aria-label="Delete workspace">🗑</button></form></div></div>`;
    }
  }

  function renderWorkspaceRows(): string {
    const entries = registry.list();
    if (entries.length === 0) {
      return `<div class="row" id="no_workspaces_row"><div><div class="r-title">No workspaces</div><div class="r-sub">Create one below.</div></div><span></span></div>`;
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
<html lang="en" data-theme="cappuccino">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="turbo-cache-control" content="no-cache">
<title>${escapeHtml(atelierName)} · ${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="${assetPath("/favicon.svg")}">
<link rel="stylesheet" href="${assetPath("/style.css")}">
<link rel="stylesheet" href="${assetPath("/provisioning.css")}">
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

  async function launchRepoAgentModal(repo: RepositorySummary, selectedModel?: string, options: { autoShow?: boolean; modalId?: string; formId?: string } = {}): Promise<string> {
    const modalId = options.modalId ?? domId("agent_launch_repo_modal", repo.id);
    const formId = options.formId ?? domId("agent_launch_repo_form", repo.id);
    const initialText = "";
    return `<dialog id="${modalId}" class="agent-launch-modal" data-controller="modal submit-shortcut"${options.autoShow ? ` data-modal-auto-show-value="true"` : ""}>
  <div class="agent-launch-title">Create workspace from <b>${escapeHtml(repo.name)}</b>, and then…</div>
  ${await renderAgentComposer({
    action: `/repo-agent-workspaces/${encodeURIComponent(repo.id)}`,
    draftId: crypto.randomUUID(),
    formId,
    placeholder: "Describe what you want the agent to do… (optional)",
    initialText,
    submitLabel: "Create workspace",
    submitShortcut: "⌘↩",
    rows: 8,
    formActions: "keydown->submit-shortcut#keydown turbo:submit-end->modal#submitted",
    selectedModel,
  })}
</dialog>`;
  }

  function addRepositoryModal(): string {
    return `<dialog id="add-repository-modal" class="modal" data-controller="modal">
  <form method="post" action="/repositories" data-action="turbo:submit-end->modal#submitted">
    <h2>Add repository</h2>
    <p>Save a remote URL. Add <code>#branch</code> to clone a specific branch.</p>
    <input class="modal-input" name="gitUrl" type="text" placeholder="https://github.com/org/repo.git#main or /path/to/repo#feature" required autofocus>
    <div class="modal-actions">
      <button class="btn" type="button" data-action="modal#close">Cancel</button>
      <button class="btn primary" type="submit">Add repository</button>
    </div>
  </form>
</dialog>`;
  }

  function isGitHubRemoteUrl(gitUrl: string): boolean {
    return /(^|@|\/)github\.com[:/]/i.test(gitUrl.trim());
  }

  async function canReadRemoteWithConfiguredToken(gitUrl: string): Promise<boolean> {
    const token = discoverHostGitHubToken();
    const credentialHelper = `!f() { test "$1" = get || exit 0; token="\${GH_TOKEN:-}"; [ -n "$token" ] || exit 0; echo username=x-access-token; echo password="$token"; }; f`;
    const proc = Bun.spawn(["git", "-c", `credential.helper=${credentialHelper}`, "ls-remote", "--exit-code", gitUrl, "HEAD"], {
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(token ? { GH_TOKEN: token } : {}) },
    });
    await new Response(proc.stderr).text().catch(() => "");
    return await proc.exited === 0;
  }

  async function githubRepoAccessProblem(repo: RepositorySummary): Promise<"missing-token" | "token-denied" | undefined> {
    if (process.env.NODE_ENV === "test" || !isGitHubRemoteUrl(repo.gitUrl)) return undefined;
    if (await canReadRemoteWithConfiguredToken(repo.gitUrl).catch(() => false)) return undefined;
    return hasWorkspaceGitHubToken() ? "token-denied" : "missing-token";
  }

  function githubRepoAccessProblemModal(repo: RepositorySummary, problem: "missing-token" | "token-denied"): string {
    const title = problem === "missing-token" ? "Connect GitHub to clone this repository" : "GitHub token cannot access this repository";
    const body = problem === "missing-token"
      ? `<p><b>${escapeHtml(repo.name)}</b> looks private, and Atelier does not have a GitHub token yet.</p><p>Connect GitHub in workspace settings, then try creating this workspace again.</p>`
      : `<p>Atelier has a GitHub token, but GitHub would not allow it to read <b>${escapeHtml(repo.name)}</b>.</p><p>Reconnect GitHub with a token that has access to this repository, then try again.</p>`;
    return `<dialog id="github-token-required-modal" class="modal" data-controller="modal" data-modal-auto-show-value="true">
  <form method="dialog">
    <h2>${escapeHtml(title)}</h2>
    ${body}
    <div class="modal-actions">
      <button class="btn" value="cancel">Cancel</button>
      <a class="btn primary" href="/settings?section=workspaces" data-turbo-frame="_top" data-turbo-stream="true">Open workspace settings</a>
    </div>
  </form>
</dialog>`;
  }

  async function renderWorkspaceSidebar(): Promise<string> {
    const { repos } = await listRepositories();

    // JavaScript submits this as a Turbo Stream and then switches the resident
    // client-side. Without JavaScript, the endpoint still falls back to a 303.
    const newWorkspaceRow = `<form class="contents" method="post" action="/workspaces" data-turbo="false" data-action="submit->workspace-list#createWorkspace"><button class="row ghost-row addbtn" type="submit">
    <span class="ic" aria-hidden="true">+</span><div><div class="r-title">New workspace</div></div>
    <span></span>
  </button></form>`;

    const repoRows = repos.map((repo) => {
      const modalId = domId("agent_launch_repo_modal", repo.id);
      const spec = formatRepositorySpec(repo);
      return `<button class="row repository-row repo-tinted-row" type="button" style="${repoColorStyle(repo.id)}" title="${escapeHtml(spec)}" aria-label="Start agent workspace from ${escapeHtml(repo.name)}" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="${modalId}">
    <span class="repo-swatch" aria-hidden="true"></span><span class="row-main"><span class="r-title">${escapeHtml(repo.name)}</span></span>
    <span class="row-actions"><span class="repo-launch-icon" aria-hidden="true">+</span></span>
  </button>`;
    }).join("");

    const addRepoRow = `<button class="row ghost-row addbtn" type="button" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="add-repository-modal">
    <span class="ic" aria-hidden="true">+</span><div><div class="r-title">Add repository</div></div>
    <span></span>
  </button>`;

    return `<turbo-frame id="workspace_sidebar" data-controller="workspace-list">
    <div class="sidebar-content">
      <div class="lh">Workspaces</div>
      <div class="table workspace-sidebar-table list">
        <div id="workspaces_table_rows">${renderWorkspaceRows()}</div>
        ${newWorkspaceRow}
      </div>

      <section class="host-repos sidebar-host-repos repos">
        <div class="lh">Repositories</div>
        <div class="table repositories-table">
          ${repoRows || `<div class="row"><span class="repo-swatch" aria-hidden="true"></span><div><div class="r-title">No repositories</div><div class="r-sub">Add one below.</div></div><span></span></div>`}
          ${addRepoRow}
        </div>
      </section>
    </div>
    <div class="sidefoot">
      <a class="footbtn" href="/settings" data-turbo-frame="_top" data-turbo-stream="true"><span class="gi">⚙</span><span class="ftext">Settings</span></a>
      <button class="footbtn collapse" type="button" aria-label="Collapse workspace list" title="Collapse workspace list" data-workspace-shell-target="toggle" data-action="click->workspace-shell#toggle"><span class="gi">‹</span><span class="ftext">Collapse</span></button>
    </div>
  </turbo-frame>`;
  }

  // ---------------------------------------------------------------------------
  // Workspace detail (residency host, groups, tabs)
  // ---------------------------------------------------------------------------

  async function attachWorkspaceModules(workspaceId: string): Promise<WorkspaceAttachment[]> {
    const entry = requireWorkspace(workspaceId);
    return await Promise.all(workspaceModules.map((module) => module.attachToWorkspace({ workspaceId, sourceRepositoryId: entry.sourceRepositoryId })));
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

  function renderThemeMenu(): string {
    const themes = [
      ["daylight", "Daylight"],
      ["solarized-light", "Solarized Light"],
      ["cappuccino", "Cappuccino"],
      ["tokyo-night", "Tokyo Night"],
      ["midnight", "Midnight"],
      ["nord", "Nord"],
    ];
    return `<label class="theme-settings" title="Theme"><span aria-hidden="true">⚙</span><select data-controller="theme-select" aria-label="Theme">${themes.map(([value, label]) => `<option value="${value}"${value === "cappuccino" ? " selected" : ""}>${label}</option>`).join("")}</select></label>`;
  }

  function renderWorkspaceGroups(workspaceId: string, tabs: WorkspaceTabContribution[], attachments: WorkspaceAttachment[]): string {
    const layoutState = layouts.normalize(workspaceId, tabs.map((tab) => tab.key));
    const tabByKey = new Map(tabs.map((tab) => [tab.key, tab]));
    const allCommands = attachments.flatMap((attachment) => attachment.workspaceCommands ?? []);
    const commands = allCommands.filter((command) => command.surfaces?.ui?.placement === "group-menu");
    const shortcutCommands = allCommands.flatMap((command) => {
      const binding = command.surfaces?.shortcut?.defaultBinding;
      return binding ? [{ id: command.id, binding }] : [];
    });
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
    return `<div class="workspace-groups" id="${workspaceGroupsId(workspaceId)}" data-controller="workspace-groups" data-workspace-groups-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-command-shortcuts="${escapeHtml(JSON.stringify(shortcutCommands))}">${groups}</div>`;
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

  function workspaceBootResidentHtml(entry: WorkspaceEntry, options: { active?: boolean } = {}): string {
    const inner = provisioning.render(entry.id, { failed: entry.phase === "failed", error: entry.error });
    return `<div class="workspace-detail-resident workspace-boot ${options.active ? "active" : ""}" id="${workspaceBootId(entry.id)}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(entry.id)}"><div class="main"><header class="header"><h1>${escapeHtml(workspaceTitle(entry))}</h1></header><div class="body"><div class="panel">${inner}</div></div></div></div>`;
  }

  function broadcastWorkspaceBoot(id: string): void {
    const entry = registry.get(id);
    if (!entry || (entry.phase !== "starting" && entry.phase !== "failed")) return;
    hub.broadcast(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
  }

  deps.events?.on("workspace_provision_step", (event) => provisioning.apply(event));

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

  async function repositoryById(id: string): Promise<RepositorySummary> {
    const { repos } = await listRepositories();
    const repo = repos.find((candidate) => candidate.id === id);
    if (!repo) throw new AtelierCoreError("repository_not_found", `repository not found: ${id}`);
    return repo;
  }

  async function renderRepoLaunchModals(): Promise<string> {
    const { repos } = await listRepositories();
    const selectedModel = await preferredNewAgentModel();
    return (await Promise.all(repos.map((repo) => launchRepoAgentModal(repo, selectedModel)))).join("");
  }

  async function renderWorkspaceShell(selectedId?: string): Promise<string> {
    return `<div class="app workspace-shell" data-controller="workspace-shell atelier-shortcuts">
    <aside class="workspace-shell-sidebar" data-workspace-shell-target="sidebar">${await renderWorkspaceSidebar()}</aside>
    <main class="workspace-shell-main">${await workspaceDetailHostHtml(selectedId)}</main>
    <div class="top-settings">${renderThemeMenu()}</div>
  </div>
  ${addRepositoryModal()}
  <div id="settings_modal_host"></div>
  <div id="onboarding_modal_host">${await renderOnboardingDialogIfNeeded()}</div>
  <div id="${workspaceCommandModalHostId}"></div>
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
    provisioning.seed(id);
    void (async () => {
      try {
        await deps.provisionWorkspace(id, { context: options.context });
        registry.setPhase(id, "ready");
        await broadcastWorkspaceReady(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`could not provision workspace ${id}: ${message}`);
        registry.setPhase(id, "failed", message);
        provisioning.apply({ workspaceId: id, id: "workspace.failed", label: "Workspace creation failed", status: "failed", error: message });
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
    const repo = await repositoryById(repoName);
    const accessProblem = await githubRepoAccessProblem(repo);
    if (accessProblem) return turboStreamResponse(turboUpdateStream(workspaceCommandModalHostId, githubRepoAccessProblemModal(repo, accessProblem)));
    const form = await request.formData();
    const text = String(form.get("text") ?? "").trim();
    const id = generateWorkspaceId();
    registry.add(id, null, repo.id, repo.name);
    const model = String(form.get("model") ?? "");
    await rememberPreferredNewAgentModel(model);
    const context: WorkspaceCreationContext = {
      sourceRepositoryId: repo.id,
      sourceRepositoryName: repo.name,
      gitUrl: repo.gitUrl,
      gitBranch: repo.branch,
      ...(text ? {
        agent: {
          initialPrompt: text,
          model,
          thinkingLevel: String(form.get("level") ?? ""),
          attachmentDraft: String(form.get("attachmentDraft") ?? ""),
        },
      } : {}),
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

  function scheduleWorkspaceDeletion(id: string): void {
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
  }

  async function forceDeleteAllWorkspacesFromSettings(): Promise<{ deleted: number; errors: string[] }> {
    const { workspaces } = await listWorkspaces();
    let deleted = 0;
    const errors: string[] = [];
    for (const workspace of workspaces) {
      const entry = registry.get(workspace.id);
      if (entry?.phase === "ready" || entry?.phase === "checking_delete") {
        try { registry.setPhase(workspace.id, "deleting"); } catch { /* best-effort UI update */ }
      }
      try {
        await deps.destroyWorkspace(workspace.id);
        registry.remove(workspace.id);
        deleted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${workspace.id}: ${message}`);
        logError(`could not force delete workspace ${workspace.id}: ${message}`);
        if (registry.get(workspace.id)?.phase === "deleting") registry.setPhase(workspace.id, "failed", `Delete failed: ${message}`);
      }
    }
    return { deleted, errors };
  }

  async function deleteCurrentWorkspaceFromAgent(id: string, force: boolean): Promise<{ deleted: boolean; blocked: boolean; details?: WorkspaceDeleteBlockedDetails }> {
    const entry = requireWorkspace(id);
    if (entry.phase !== "ready") throw new AtelierCoreError("workspace_not_ready", `workspace ${id} is not ready for deletion`);
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
        return { deleted: false, blocked: true, details };
      }
    }
    scheduleWorkspaceDeletion(id);
    return { deleted: true, blocked: false };
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
    scheduleWorkspaceDeletion(id);
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
    const entry = requireWorkspace(id);
    const formData = await request.formData();
    const title = String(formData.get("title") ?? "").trim();
    await setWorkspaceTitle(id, title);
    registry.setTitle(id, title || null);
    return response(workspaceSidebarTitleFrame(id, workspaceTitle(entry)));
  }

  // ---------------------------------------------------------------------------
  // Repositories / mergeability / push
  // ---------------------------------------------------------------------------

  async function createRepositoryFromForm(request: Request, url: URL): Promise<Response> {
    const formData = await request.formData();
    const gitUrl = String(formData.get("gitUrl") ?? "");
    await addRepository(gitUrl);
    return Response.redirect(new URL("/", url).toString(), 303);
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

  async function executeWorkspaceCommand(workspaceId: string, commandId: string): Promise<{ createdTabKey?: string; streamHtml?: string }> {
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
      case "desktop.start":
        await ensureWorkspaceDesktop(workspaceId);
        return { createdTabKey: desktopTabKey };
      case "agent.launch-source-repo-workspace": {
        const entry = requireWorkspace(workspaceId);
        if (!entry.sourceRepositoryId) throw new AtelierCoreError("source_repo_not_found", `workspace ${workspaceId} was not created from a repository`);
        const repo = await repositoryById(entry.sourceRepositoryId);
        const modal = await launchRepoAgentModal(repo, await preferredNewAgentModel(), {
          autoShow: true,
          modalId: domId("agent_launch_source_repo_modal", workspaceId, repo.id),
          formId: domId("agent_launch_source_repo_form", workspaceId, repo.id),
        });
        return { streamHtml: turboUpdateStream(workspaceCommandModalHostId, modal) };
      }
      default:
        throw new AtelierCoreError("command_not_implemented", `workspace command not implemented: ${commandId}`);
    }
  }

  function workspaceGroupsTurboStream(workspaceId: string, tabs: WorkspaceTabContribution[], attachments: WorkspaceAttachment[]): string {
    return turboReplaceStream(workspaceGroupsId(workspaceId), renderWorkspaceGroups(workspaceId, tabs, attachments));
  }

  async function workspaceGroupCommandEndpoint(workspaceId: string, groupId: string, commandId: string): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId);
    const { attachments, tabs } = await workspaceTabsAndAttachments(workspaceId);
    if (result.createdTabKey) layouts.placeNewTab(workspaceId, tabs.map((tab) => tab.key), groupId, result.createdTabKey);
    return turboStreamResponse(`${workspaceGroupsTurboStream(workspaceId, tabs, attachments)}${result.streamHtml ?? ""}`);
  }

  async function workspaceCommandEndpoint(workspaceId: string, commandId: string): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId);
    if (!result.createdTabKey) return turboStreamResponse(result.streamHtml ?? "");

    const { attachments, tabs } = await workspaceTabsAndAttachments(workspaceId);
    const tabKeys = tabs.map((tab) => tab.key);
    const groupId = layouts.normalize(workspaceId, tabKeys).groups.find((group) => group.activeTab)?.id;
    if (groupId) layouts.placeNewTab(workspaceId, tabKeys, groupId, result.createdTabKey);
    return turboStreamResponse(`${workspaceGroupsTurboStream(workspaceId, tabs, attachments)}${result.streamHtml ?? ""}`);
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
    if (url.pathname === "/repositories" && request.method === "POST") return await createRepositoryFromForm(request, url);

    const match = (pattern: RegExp): string[] | undefined => {
      const result = url.pathname.match(pattern);
      return result ? result.slice(1).map(decodeURIComponent) : undefined;
    };

    const settingsResponse = await handleSettingsRequest(request, url, { forceDeleteAllWorkspaces: forceDeleteAllWorkspacesFromSettings });
    if (settingsResponse) return settingsResponse;

    const onboardingResponse = await handleOnboardingRequest(request, url);
    if (onboardingResponse) return onboardingResponse;

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
    if ((params = match(/^\/workspaces\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") return await workspaceCommandEndpoint(params[0], params[1]);
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
