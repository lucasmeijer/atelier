import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  getConfiguredAgentModels,
  renderAgentComposer,
  rememberPreferredNewAgentModel as rememberAgentPreferredNewAgentModel,
} from "@atelier/agent/server";
import {
  AtelierCoreError,
  currentAtelierContainerImageId,
  invalidArguments,
  type AtelierEventBus,
} from "@atelier/core";
import { discoverHostGitHubToken, hasWorkspaceGitHubToken } from "@atelier/proxy-egress";
import {
  addProject,
  deleteProject,
  formatProjectSpec,
  isGitProjectInit,
  listProjects,
  projectWorkspaceInit,
  type ProjectSummary,
  type WorkspaceDeleteBlockedDetails,
} from "@atelier/projects";
import { generateWorkspaceId, listWorkspaces, setWorkspaceParked, setWorkspaceTitle, type WorkspaceCreationContext, type WorkspaceInitInstruction } from "@atelier/workspace";
import { createWorkspaceProvisioningStore } from "@atelier/workspace/server/provisioning";
import {
  atelierName,
  CableTopics,
  domId,
  escapeHtml,
  providerBrandColor,
  providerBrandIconHtml,
  turboStream,
  turboStreamResponse,
  type AgentWorkspaceCreateRequest,
  type AgentWorkspaceCreateResult,
  type AgentWorkspaceForkRequest,
  type AgentWorkspaceParameters,
  type CableIdentifier,
  type GlobalSidebarContributionRegistry,
  type WorkspaceAttachment,
  type WorkspaceCommandContribution,
  type WorkspaceModuleCommandHandler,
  type WorkspaceModuleCommandResult,
  type WorkspaceModuleRouteHandler,
  type WorkspaceModuleTabLifecycleHandler,
  type WorkspaceRowContributionRegistry,
  type WorkspaceServerProvisioningHook,
  type WorkspaceTabContribution,
} from "@atelier/shared";
import type { WorkspaceLayoutStore } from "./workspace-layout.ts";
import type { WebPreferenceStore } from "./preferences.ts";
import type { WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceModules } from "./workspace-modules.ts";
import { handleSettingsRequest, renderSettingsDialog } from "./settings/routes.ts";
import { handleOnboardingRequest, renderOnboardingDialogIfNeeded } from "./onboarding/routes.ts";
import { GitHubRepositorySearchRateLimitError, renderGitHubRepositorySearchMenu, renderGitHubRepositorySearchRateLimitMenu, searchGitHubRepositories, shouldSearchGitHubRepositories } from "./github-repo-search.ts";

export interface WebAppDeps {
  registry: WorkspaceRegistry;
  cable?: { broadcast(identifier: CableIdentifier, html: string): void };
  layouts: WorkspaceLayoutStore;
  /** Event bus passed through to the agent module routes. */
  events?: AtelierEventBus;
  /** File-backed UI preferences for future/new agent creation flows. */
  preferences?: WebPreferenceStore;
  /** Create the container + default agent etc. for an already-registered workspace id. */
  provisionWorkspace(id: string, options?: { init?: import("@atelier/workspace").WorkspaceInitInstruction; context?: WorkspaceCreationContext; fork?: { sourceWorkspaceId: string } }): Promise<void>;
  inspectDeleteSafety(id: string): Promise<WorkspaceDeleteBlockedDetails>;
  /** Force-remove the workspace container. */
  destroyWorkspace(id: string): Promise<void>;
  /** Persist parked state in the workspace container. Defaults to setWorkspaceParked. */
  persistWorkspaceParked?(id: string, parked: boolean): Promise<void>;
  /** Receives background task failures. Defaults to console.error. */
  logError?(message: string): void;
  provisioningHooks: WorkspaceServerProvisioningHook[];
  workspaceRemovedHandlers?: Array<(workspaceId: string) => void | Promise<void>>;
}

export interface WebApp {
  fetch(request: Request): Promise<Response>;
  shellSnapshot(): string;
  tabKeysFor(workspaceId: string): Promise<string[]>;
  deleteCurrentWorkspaceFromAgent(workspaceId: string, force: boolean): Promise<{ deleted: boolean; blocked: boolean; details?: WorkspaceDeleteBlockedDetails }>;
  createWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceCreateRequest): Promise<AgentWorkspaceCreateResult>;
  forkCurrentWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceForkRequest): Promise<AgentWorkspaceCreateResult>;
  workspaceRowContributions: WorkspaceRowContributionRegistry;
  globalSidebarContributions: GlobalSidebarContributionRegistry;
}

type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };

function response(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(body, { ...init, headers });
}

function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

function jsonResponse(body: unknown, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function problemJsonResponse(error: unknown): Response {
  const status = error instanceof AtelierCoreError && error.code === "invalid_arguments" ? 400
    : error instanceof AtelierCoreError && ["project_not_found", "workspace_not_found"].includes(error.code) ? 404
      : 500;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof AtelierCoreError ? error.code : "internal_error";
  return jsonResponse({ error: { code, message } }, { status });
}

function turboReplaceStream(target: string, html: string): string {
  return turboStream("replace", target, html);
}

function turboRemoveStream(target: string): string {
  return turboStream("remove", target);
}

/** Replaces the children of the target, keeping the container element itself alive. */
function turboUpdateStream(target: string, html: string): string {
  return turboStream("update", target, html);
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

function atelierVersionTooltip(imageId = currentAtelierContainerImageId()): string {
  if (imageId) return `Container image ${imageId}`;
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
  const { registry, layouts } = deps;
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const currentAtelierImageId = currentAtelierContainerImageId();
  const versionTooltip = atelierVersionTooltip(currentAtelierImageId);

  function broadcastShell(html: string): void {
    deps.cable?.broadcast(CableTopics.shell(), html);
  }

  const provisioning = createWorkspaceProvisioningStore({ onChange: (workspaceId) => broadcastWorkspaceBoot(workspaceId), seedSteps: deps.provisioningHooks });
  const workspaceCommandModalHostId = "workspace_command_modal_host";
  const projectLaunchModalsId = "project_launch_modals";

  async function preferredNewAgentModel(): Promise<string | undefined> {
    const configuredModels = await getConfiguredAgentModels();
    const active = configuredModels.find((model) => model.active) ?? configuredModels[0];
    return active ? `${active.provider}::${active.id}` : undefined;
  }

  // ---------------------------------------------------------------------------
  // Workspace sidebar rendering. Broadcast HTML never contains per-client state
  // (no "visible" classes, no selection inputs); selection is applied client-side
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
    const state = registry.workspaceState(workspaceId);
    const inner = state === "busy"
      ? `<span class="status-spinner sm" aria-label="Workspace busy" title="Workspace busy"></span>`
      : state === "unread"
        ? `<span class="status-dot" aria-label="Workspace unread" title="Workspace unread"></span>`
        : "";
    return `<span id="${workspaceStatusId(workspaceId)}" class="workspace-status" data-workspace-state="${state}">${inner}</span>`;
  }

  function renderTabStatus(workspaceId: string, tabKey: string): string {
    const inner = registry.isTabBusy(workspaceId, tabKey)
      ? `<span class="status-spinner sm" aria-label="Tab busy" title="Tab busy"></span>`
      : "";
    return `<span id="${workspaceTabStatusId(workspaceId, tabKey)}" class="tab-status">${inner}</span>`;
  }

  const workspaceRowContributionStore = new Map<string, Map<string, string>>();

  function workspaceRowContributionsId(workspaceId: string): string {
    return domId("workspace_row_contributions", workspaceId);
  }

  function workspaceHasVersionWarning(entry: WorkspaceEntry): boolean {
    return Boolean(currentAtelierImageId && entry.createdByAtelierImageId !== currentAtelierImageId);
  }

  function renderWorkspaceVersionContribution(entry: WorkspaceEntry): string {
    if (!workspaceHasVersionWarning(entry)) return "";
    return `<span class="workspace-version-warning" aria-label="Workspace created with an older version of Atelier" data-tooltip="This workspace was created with an older version of Atelier. This is usually fine, but some newer features might only work in a new workspace">⚠︎</span>`;
  }

  function renderWorkspaceRowContributions(entry: WorkspaceEntry): string {
    const workspaceId = entry.id;
    const contributions = [renderWorkspaceVersionContribution(entry), ...Array.from(workspaceRowContributionStore.get(workspaceId)?.values() ?? [])].filter(Boolean).join("");
    return `<span id="${workspaceRowContributionsId(workspaceId)}" class="workspace-row-contributions">${contributions}</span>`;
  }

  const workspaceRowContributions: WorkspaceRowContributionRegistry = {
    set(workspaceId: string, contributionId: string, html?: string) {
      const entry = registry.get(workspaceId);
      if (!entry) return;
      let workspaceContributions = workspaceRowContributionStore.get(workspaceId);
      if (!workspaceContributions) workspaceRowContributionStore.set(workspaceId, workspaceContributions = new Map());
      if (html) workspaceContributions.set(contributionId, html);
      else workspaceContributions.delete(contributionId);
      broadcastShell(turboReplaceStream(workspaceRowContributionsId(workspaceId), renderWorkspaceRowContributions(entry)));
    },
  };

  const globalSidebarContributionStore = new Map<string, string>();

  function renderGlobalSidebarContributions(): string {
    return Array.from(globalSidebarContributionStore.values()).filter(Boolean).join("");
  }

  const globalSidebarContributions: GlobalSidebarContributionRegistry = {
    set(contributionId: string, html?: string) {
      if (html) globalSidebarContributionStore.set(contributionId, html);
      else globalSidebarContributionStore.delete(contributionId);
      const streamHtml = turboUpdateStream("global_sidebar_contributions", renderGlobalSidebarContributions());
      broadcastShell(streamHtml);
      deps.cable?.broadcast(CableTopics.update(), streamHtml);
    },
  };

  function workspaceTitle(entry: WorkspaceEntry): string {
    return entry.title || (isGitProjectInit(entry.init) ? entry.init.name : undefined) || `Workspace ${entry.id}`;
  }

  function workspaceSidebarTitleFrame(entry: WorkspaceEntry): string {
    const id = entry.id;
    const frameId = domId("workspace_sidebar_title", id);
    return `<turbo-frame id="${frameId}" class="workspace-row-title-frame">
    <a class="row-main" href="/workspaces/${encodeURIComponent(id)}" data-turbo="false" data-action="workspace-list#select"><div class="r-title">${escapeHtml(workspaceTitle(entry))}</div></a>
  </turbo-frame>`;
  }

  function workspaceDeleteForm(id: string, buttonTitle = "Delete workspace"): string {
    return `<form class="workspace-row-delete" method="post" action="/workspaces/${encodeURIComponent(id)}/delete" data-action="submit->workspace-list#deleteStarted"><button type="submit" title="${escapeHtml(buttonTitle)}" aria-label="Delete workspace">🗑</button></form>`;
  }

  function workspaceRow(entry: WorkspaceEntry): string {
    const id = entry.id;
    const title = workspaceTitle(entry);
    const selectable = entry.phase === "starting" || entry.phase === "failed" || entry.phase === "ready";
    const projectClass = isGitProjectInit(entry.init) ? "repo-tinted-row" : "";
    const projectStyle = isGitProjectInit(entry.init) ? ` style="${repoColorStyle(entry.init.projectId)}"` : "";
    const stateClass = registry.workspaceState(id) === "unread" ? "attn-state" : "";
    const parkedClass = entry.parked ? "parked" : "";
    const versionWarningClass = workspaceHasVersionWarning(entry) ? "has-version-warning" : "";
    const open = (extraClass: string) => `<div class="row workspace-row ${projectClass} ${stateClass} ${parkedClass} ${versionWarningClass} ${extraClass}" id="${workspaceRowId(id)}" data-workspace-id="${escapeHtml(id)}" data-phase="${entry.phase}" data-parked="${entry.parked ? "true" : "false"}"${projectStyle}${selectable ? ` data-action="click->workspace-list#rowClicked"` : ""}>`;
    const workspaceLink = (label: string, attrs = "") => `<a class="row-main" href="/workspaces/${encodeURIComponent(id)}" data-turbo="false" data-action="workspace-list#select"${attrs}><div class="r-title">${escapeHtml(label)}</div></a>`;
    switch (entry.phase) {
      // All phases render single-line rows (no r-sub) so phase changes never
      // change row height.
      case "starting":
        return `${open("starting")}${workspaceLink(title, ` title="Preparing workspace…"`)}<span class="row-actions"><span class="status-spinner sm" aria-label="Preparing" title="Preparing workspace…"></span></span></div>`;
      case "checking_delete":
      case "deleting":
        return `${open("pending-delete")}<div class="row-main" title="Deleting…"><div class="r-title">${escapeHtml(title)}</div></div><span class="row-actions"><span class="status-spinner sm" aria-label="Deleting" title="Deleting…"></span></span></div>`;
      case "failed": {
        const error = entry.error ?? "Workspace failed";
        return `${open("failed")}${workspaceLink(title, ` title="${escapeHtml(error)}"`)}${workspaceDeleteForm(id, `${error} — delete`)}</div>`;
      }
      case "ready": {
        const parkedAction = entry.parked ? "unpark" : "park";
        const parkedLabel = entry.parked ? "Unpark workspace" : "Park workspace";
        return `${open("")}${workspaceSidebarTitleFrame(entry)}<div class="workspace-row-actions"><span class="workspace-row-notifiers">${renderWorkspaceRowContributions(entry)}${renderWorkspaceStatus(id)}</span><span class="workspace-row-buttons"><a class="workspace-row-edit" href="/workspaces/${encodeURIComponent(id)}/sidebar-title/edit" data-turbo-frame="${domId("workspace_sidebar_title", id)}" title="Rename workspace" aria-label="Rename workspace">✎</a><form class="workspace-row-park" method="post" action="/workspaces/${encodeURIComponent(id)}/${parkedAction}" data-turbo="true" data-action="turbo:submit-end->workspace-list#parkToggled"><button type="submit" title="${parkedLabel}" aria-label="${parkedLabel}">💤</button></form>${workspaceDeleteForm(id)}</span></div></div>`;
      }
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
    rowChanged(entry, { tabKey, unread }) {
      if (tabKey !== undefined) {
        if (unread) {
          void (async () => {
            const tabKeys = await tabKeysFor(entry.id);
            if (layouts.revealTab(entry.id, tabKeys, tabKey)) broadcastShell(await replaceWorkspaceGroupsTurboStream(entry.id));
          })().catch((error) => logError(`could not reveal unread tab for workspace ${entry.id}: ${error instanceof Error ? error.message : String(error)}`));
        }
        // Status changes replace only the status spans so they cannot clobber an
        // in-progress title edit in the row.
        broadcastShell(`${turboReplaceStream(workspaceStatusId(entry.id), renderWorkspaceStatus(entry.id))}${turboReplaceStream(workspaceTabStatusId(entry.id, tabKey), renderTabStatus(entry.id, tabKey))}`);
        return;
      }
      broadcastShell(turboReplaceStream(workspaceRowId(entry.id), workspaceRow(entry)));
    },
    listChanged() {
      // "update" (not "replace"): the rows container must survive so later
      // list broadcasts still find their target.
      broadcastShell(turboUpdateStream("workspaces_table_rows", renderWorkspaceRows()));
    },
    parkedChanged(entry) {
      void (deps.persistWorkspaceParked ?? setWorkspaceParked)(entry.id, entry.parked).catch((error) => logError(`could not persist parked state for workspace ${entry.id}: ${error instanceof Error ? error.message : String(error)}`));
    },
    removed(id) {
      layouts.delete(id);
      workspaceRowContributionStore.delete(id);
      for (const handler of deps.workspaceRemovedHandlers ?? []) void handler(id);
      broadcastShell(turboRemoveStream(workspaceRowId(id)));
    },
  });

  // ---------------------------------------------------------------------------
  // Page shell
  // ---------------------------------------------------------------------------

  function moduleStylesHtml(): string {
    return workspaceModules.flatMap((module) => Object.entries(module.staticFiles ?? {}))
      .filter(([path, entry]) => path.endsWith(".css") && entry.contentType.toLowerCase().startsWith("text/css"))
      .map(([path]) => `<link rel="stylesheet" href="${assetPath(path)}">`)
      .join("\n");
  }

  function layout(title: string, body: string, workspaceId?: string): string {
    const pageId = randomUUID();
    return `<!DOCTYPE html>
<html lang="en" data-theme="nord" data-atelier-page-id="${escapeHtml(pageId)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="turbo-cache-control" content="no-cache">
<title>${escapeHtml(atelierName)}</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#172033">
<link rel="stylesheet" href="${assetPath("/style.css")}">
<link rel="stylesheet" href="${assetPath("/provisioning.css")}">
${moduleStylesHtml()}
<script type="module" src="https://cdn.jsdelivr.net/npm/@hotwired/turbo@8.0.13/dist/turbo.es2017-esm.js"></script>
<script type="module">
  import { Application, Controller } from "https://cdn.jsdelivr.net/npm/@hotwired/stimulus@3.2.2/+esm";
  window.Stimulus = { Application, Controller };
</script>
<script type="module" src="${assetPath("/workspace.js")}"></script>
</head>
<body id="body" data-controller="cable-shell">${body}
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

  function repoSwatch(projectId: string): string {
    return `<span class="repo-swatch" style="${repoColorStyle(projectId)}" aria-hidden="true"></span>`;
  }

  async function launchAgentWorkspaceModal(options: { titleHtml: string; action: string; modalId: string; formId: string; selectedModel?: string; autoShow?: boolean }): Promise<string> {
    return `<dialog id="${options.modalId}" class="agent-launch-modal" data-controller="modal submit-shortcut"${options.autoShow ? ` data-modal-auto-show-value="true"` : ""}>
  <div class="agent-launch-title">${options.titleHtml}</div>
  ${await renderAgentComposer({
    action: options.action,
    draftId: crypto.randomUUID(),
    formId: options.formId,
    placeholder: "Describe what you want the agent to do… (optional)",
    initialText: "",
    submitLabel: "Create workspace",
    submitShortcut: "⌘↩",
    rows: 8,
    formActions: "keydown->submit-shortcut#keydown submit->submit-shortcut#submit turbo:submit-end->submit-shortcut#submitted turbo:submit-end->modal#submitted",
    formTurbo: true,
    selectedModel: options.selectedModel,
  })}
</dialog>`;
  }

  async function launchProjectAgentModal(project: ProjectSummary, selectedModel?: string, options: { autoShow?: boolean; modalId?: string; formId?: string } = {}): Promise<string> {
    return await launchAgentWorkspaceModal({
      titleHtml: `Create workspace from <b>${escapeHtml(project.name)}</b>, and then…`,
      action: `/project-agent-workspaces/${encodeURIComponent(project.id)}`,
      modalId: options.modalId ?? domId("agent_launch_project_modal", project.id),
      formId: options.formId ?? domId("agent_launch_project_form", project.id),
      selectedModel,
      autoShow: options.autoShow,
    });
  }

  async function launchEmptyAgentModal(selectedModel?: string): Promise<string> {
    return await launchAgentWorkspaceModal({
      titleHtml: "Create empty workspace, and then…",
      action: "/agent-workspaces",
      modalId: "agent_launch_empty_workspace_modal",
      formId: "agent_launch_empty_workspace_form",
      selectedModel,
    });
  }

  function deleteProjectModal(project: ProjectSummary): string {
    return `<dialog id="${domId("delete_project_modal", project.id)}" class="modal project-delete-modal" data-controller="modal">
  <form method="post" action="/projects/${encodeURIComponent(project.id)}/delete" data-action="turbo:submit-end->modal#submitted">
    <h2 class="project-delete-title">Delete ${repoSwatch(project.id)} ${escapeHtml(project.name)}?</h2>
    <div class="modal-actions">
      <button class="btn" type="button" data-action="modal#close">Cancel</button>
      <button class="btn danger" type="submit">Delete</button>
    </div>
  </form>
</dialog>`;
  }

  function addProjectModal(): string {
    return `<dialog id="add-project-modal" class="modal" data-controller="modal">
  <form method="post" action="/projects" data-action="turbo:submit-end->modal#submitted">
    <h2>Add project</h2>
    <p>Save a remote URL, or type a repository name to search GitHub. Add <code>#branch</code> to clone a specific branch.</p>
    <div class="project-github-search" data-controller="project-github-search" data-project-github-search-url-value="/projects/github-search">
      <input class="modal-input" name="gitUrl" type="text" placeholder="github repo, https://github.com/org/repo.git#main, or /path/to/repo#feature" required autofocus data-project-github-search-target="input" data-action="keydown->project-github-search#keydown input->project-github-search#input">
      <div class="agent-template-menu-host project-github-search-menu" data-project-github-search-target="menu" hidden></div>
    </div>
    <div class="modal-actions">
      <button class="btn" type="button" data-action="modal#close">Cancel</button>
      <button class="btn primary" type="submit">Add project</button>
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

  async function githubRepoAccessProblem(project: ProjectSummary): Promise<"missing-token" | "token-denied" | undefined> {
    if (process.env.NODE_ENV === "test" || !isGitHubRemoteUrl(project.gitUrl)) return undefined;
    if (await canReadRemoteWithConfiguredToken(project.gitUrl).catch(() => false)) return undefined;
    return hasWorkspaceGitHubToken() ? "token-denied" : "missing-token";
  }

  function githubRepoAccessProblemModal(project: ProjectSummary, problem: "missing-token" | "token-denied"): string {
    const title = problem === "missing-token" ? "Connect GitHub to clone this project" : "GitHub token cannot access this project";
    const body = problem === "missing-token"
      ? `<p><b>${escapeHtml(project.name)}</b> looks private, and Atelier does not have a GitHub token yet.</p><p>Connect GitHub in workspace settings, then try creating this workspace again.</p>`
      : `<p>Atelier has a GitHub token, but GitHub would not allow it to read <b>${escapeHtml(project.name)}</b>.</p><p>Reconnect GitHub with a token that has access to this project, then try again.</p>`;
    return `<dialog id="github-token-required-modal" class="modal" data-controller="modal" data-modal-auto-show-value="true">
  <form method="dialog">
    <h2 class="modal-brand-title"><span class="settings-provider-icon settings-provider-icon-github" style="--provider-color:${providerBrandColor("github")}">${providerBrandIconHtml("github", "GitHub")}</span>${escapeHtml(title)}</h2>
    ${body}
    <div class="modal-actions">
      <button class="btn" value="cancel">Cancel</button>
      <a class="btn primary" href="/settings?section=github" data-turbo-frame="_top" data-turbo-stream="true">Open GitHub settings</a>
    </div>
  </form>
</dialog>`;
  }

  async function renderWorkspaceSidebar(): Promise<string> {
    const { projects } = await listProjects();

    // JavaScript submits this as a Turbo Stream and then switches the resident
    // client-side. Without JavaScript, the endpoint still falls back to a 303.
    const newWorkspaceRow = `<form class="contents" method="post" action="/workspaces" data-turbo="false" data-action="submit->workspace-list#createWorkspace"><button class="row ghost-row addbtn" type="submit">
    <span class="ic" aria-hidden="true">+</span><div><div class="r-title">New workspace</div></div>
    <span></span>
  </button></form>`;

    const projectRows = projects.map((project) => {
      const modalId = domId("agent_launch_project_modal", project.id);
      const deleteModalId = domId("delete_project_modal", project.id);
      const spec = formatProjectSpec(project);
      return `<div class="row project-row repo-tinted-row" role="button" tabindex="0" style="${repoColorStyle(project.id)}" title="${escapeHtml(spec)}" aria-label="Start agent workspace from ${escapeHtml(project.name)}" data-controller="modal-opener" data-action="click->modal-opener#open keydown.enter->modal-opener#open" data-modal-opener-target-id-value="${modalId}">
    ${repoSwatch(project.id)}<span class="row-main"><span class="r-title">${escapeHtml(project.name)}</span></span>
    <span class="row-actions"><button class="project-row-delete" type="button" title="Delete project" aria-label="Delete project" data-controller="modal-opener" data-action="click->modal-opener#open" data-modal-opener-target-id-value="${deleteModalId}">🗑</button></span>
  </div>`;
    }).join("");

    const addProjectRow = `<button class="row ghost-row addbtn" type="button" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="add-project-modal">
    <span class="ic" aria-hidden="true">+</span><div><div class="r-title">Add project</div></div>
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
        <div class="lh">Projects</div>
        <div class="table projects-table">
          ${projectRows || `<div class="row"><span class="repo-swatch" aria-hidden="true"></span><div><div class="r-title">No projects</div><div class="r-sub">Add one below.</div></div><span></span></div>`}
          ${addProjectRow}
        </div>
      </section>

      <section id="global_sidebar_contributions">${renderGlobalSidebarContributions()}</section>
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
    return await Promise.all(workspaceModules
      .filter((module) => module.attachToWorkspace)
      .map((module) => module.attachToWorkspace!({ workspaceId, init: entry.init, events: deps.events })));
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

  function renderTabPane(tab: WorkspaceTabContribution, visible: boolean): string {
    if (!tab.paneHtml) return "";
    return tab.paneHtml.replace(/class="tab-pane([^\"]*)"/, (_match, classes: string) => {
      const classList = String(classes).replace(/\b(active|visible)\b/g, "").trim();
      return `class="tab-pane${classList ? ` ${classList}` : ""}${visible ? " visible" : ""}"`;
    });
  }


  function renderWorkspaceGroups(workspaceId: string, tabs: WorkspaceTabContribution[], attachments: WorkspaceAttachment[]): string {
    const layoutState = layouts.normalize(workspaceId, tabs.map((tab) => tab.key));
    const tabByKey = new Map(tabs.map((tab) => [tab.key, tab]));
    const allCommands = attachments.flatMap((attachment) => attachment.commands ?? []);
    const commands = allCommands.filter((command) => command.surfaces?.ui?.placement === "group-menu");
    const serializedCommands = allCommands.map((command) => ({
      id: command.id,
      label: command.label,
      description: command.description,
      scope: command.scope,
      binding: command.surfaces?.shortcut?.defaultBinding,
    }));
    const actionMenu = (group: { id: string }, index: number) => `<details class="group-add-menu"><summary class="group-icon-btn" title="Add tab or group">+</summary><div class="group-menu-panel">
      ${commands.map((command) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/commands/${encodeURIComponent(command.id)}"><button type="submit">${escapeHtml(command.surfaces?.ui?.label ?? command.label)}</button></form>`).join("")}
      <form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/split"><button type="submit">New Group</button></form>
      ${layoutState.groups.length > 1 && index > 0 ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/close"><button type="submit">Close Group</button></form>` : ""}
    </div></details>`;
    const groups = layoutState.groups.map((group, index) => {
      const visibleTab = group.visibleTab && group.tabs.includes(group.visibleTab) ? group.visibleTab : group.tabs[0];
      const tabHeader = (key: string, tabIndex: number) => {
        const tab = tabByKey.get(key);
        if (!tab) return "";
        const label = tabLabel(tab);
        return `<div class="group-tab ${key === visibleTab ? "visible" : "muted"}" draggable="true" data-tab="${escapeHtml(key)}" data-action="dragstart->workspace-groups#dragStart dragend->workspace-groups#dragEnd dragover->workspace-groups#dragOver drop->workspace-groups#drop" data-group-id="${escapeHtml(group.id)}" data-tab-index="${tabIndex}"><button class="group-tab-label" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="tab" data-atelier-fullscreen-tab-key-value="${escapeHtml(key)}" data-atelier-fullscreen-title-value="${escapeHtml(label)}" data-action="click->workspace-tabs#show" data-workspace-tabs-tab-param="${escapeHtml(key)}" type="button"><span>${escapeHtml(label)}</span>${renderTabStatus(workspaceId, key)}</button><form class="group-tab-close-form" data-turbo="true" data-controller="workspace-tab-close" data-workspace-tab-close-label-value="${escapeHtml(label)}" data-action="submit->workspace-tab-close#confirm" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(key)}/close"><button class="group-tab-close" type="submit" title="Close ${escapeHtml(label)}" aria-label="Close ${escapeHtml(label)}">×</button></form></div>`;
      };
      const overflowTab = (key: string) => {
        const tab = tabByKey.get(key);
        if (!tab) return "";
        const label = tabLabel(tab);
        return `<div class="group-overflow-tab" data-overflow-tab="${escapeHtml(key)}"><button class="group-overflow-tab-label" data-controller="atelier-fullscreen" data-atelier-fullscreen-mode-value="tab" data-atelier-fullscreen-tab-key-value="${escapeHtml(key)}" data-atelier-fullscreen-title-value="${escapeHtml(label)}" data-action="click->workspace-tabs#show" data-workspace-tabs-tab-param="${escapeHtml(key)}" type="button"><span>${escapeHtml(label)}</span>${renderTabStatus(workspaceId, key)}</button><form class="group-overflow-tab-close-form" data-turbo="true" data-controller="workspace-tab-close" data-workspace-tab-close-label-value="${escapeHtml(label)}" data-action="submit->workspace-tab-close#confirm" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/tabs/${encodeURIComponent(key)}/close"><button class="group-overflow-tab-close" type="submit" title="Close ${escapeHtml(label)}" aria-label="Close ${escapeHtml(label)}">×</button></form></div>`;
      };
      const headers = group.tabs.map(tabHeader).join("");
      const overflowTabs = group.tabs.map(overflowTab).join("");
      const panes = group.tabs.map((key) => {
        const tab = tabByKey.get(key);
        return tab ? renderTabPane(tab, key === visibleTab) : "";
      }).join("");
      const empty = group.tabs.length === 0;
      return `<section class="workspace-group" data-group-id="${escapeHtml(group.id)}" data-workspace-groups-target="group" style="--group-size:${group.size}">
      <div class="group-tabbar" data-controller="workspace-tabs" data-workspace-tabs-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-tabs-group-id-value="${escapeHtml(group.id)}" data-workspace-tabs-initial-tab-value="${escapeHtml(visibleTab ?? "")}" data-action="dragover->workspace-groups#dragOver drop->workspace-groups#drop">
        <div class="group-tabs">${headers}</div><details class="group-overflow-menu"><summary class="group-icon-btn" title="Hidden tabs" aria-label="Hidden tabs">…</summary><div class="group-menu-panel group-overflow-panel">${overflowTabs}</div></details>${actionMenu(group, index)}
      </div>
      <div class="workspace-panes" id="${domId("workspace_panes", workspaceId, group.id)}">${empty ? `<div class="empty-group"><p>This group is empty.</p>${layoutState.groups.length > 1 ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/remove"><button class="btn sm" type="submit">Remove Empty Group</button></form>` : ""}</div>` : panes}</div>
      ${index === layoutState.groups.length - 1 ? `<div class="new-group-drop-zone" data-new-group-drop-zone="true" data-action="dragover->workspace-groups#dragOver dragleave->workspace-groups#dragLeave drop->workspace-groups#drop" title="Drop here to create a new group" aria-label="Drop tab here to create a new group"></div>` : ""}
    </section>${index < layoutState.groups.length - 1 ? `<div class="group-resizer" data-action="pointerdown->workspace-groups#startResize" data-resizer-index="${index}" role="separator" aria-orientation="vertical"></div>` : ""}`;
    }).join("");
    const workspaceChrome = attachments.flatMap((attachment) => attachment.workspaceChromeHtml ?? []).join("");
    return `<div class="workspace-groups" id="${workspaceGroupsId(workspaceId)}" data-controller="workspace-groups" data-workspace-groups-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-commands="${escapeHtml(JSON.stringify(serializedCommands))}">${groups}${workspaceChrome}</div>`;
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

  async function workspaceDetailResidentHtml(id: string, options: { visible?: boolean } = {}): Promise<string> {
    const entry = requireWorkspace(id);
    const projectAttr = isGitProjectInit(entry.init) ? ` data-project-id="${escapeHtml(entry.init.projectId)}"` : "";
    return `<div class="workspace-detail-resident ${options.visible ? "visible" : ""}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(id)}"${projectAttr}>${await workspaceDetailContent(id)}</div>`;
  }

  function workspaceBootResidentHtml(entry: WorkspaceEntry, options: { visible?: boolean } = {}): string {
    const inner = provisioning.render(entry.id, { failed: entry.phase === "failed", error: entry.error });
    const projectAttr = isGitProjectInit(entry.init) ? ` data-project-id="${escapeHtml(entry.init.projectId)}"` : "";
    return `<div class="workspace-detail-resident workspace-boot ${options.visible ? "visible" : ""}" id="${workspaceBootId(entry.id)}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(entry.id)}"${projectAttr}><div class="main"><header class="header"><h1>${escapeHtml(workspaceTitle(entry))}</h1></header><div class="body"><div class="panel">${inner}</div></div></div></div>`;
  }

  function broadcastWorkspaceBoot(id: string): void {
    const entry = registry.get(id);
    if (!entry || (entry.phase !== "starting" && entry.phase !== "failed")) return;
    broadcastShell(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
  }

  deps.events?.on("workspace_provision_step", (event) => provisioning.apply(event));

  async function workspaceResidentFor(entry: WorkspaceEntry, options: { visible?: boolean } = {}): Promise<string> {
    if (entry.phase === "starting" || entry.phase === "failed") return workspaceBootResidentHtml(entry, options);
    return await workspaceDetailResidentHtml(entry.id, options);
  }

  async function workspaceDetailHostHtml(selectedId?: string): Promise<string> {
    const entry = selectedId ? registry.get(selectedId) : undefined;
    const resident = entry ? await workspaceResidentFor(entry, { visible: true }) : "";
    return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-residency" data-workspace-residency-max-resident-value="10">
      <div class="workspace-detail-empty" data-workspace-residency-target="empty"${resident ? " hidden" : ""}><div class="main"><header class="header"><h1>Select a workspace</h1></header><div class="body"><div class="panel"><div class="pad">Create or select a workspace to begin.</div></div></div></div></div>
      <div class="workspace-detail-loading" data-workspace-residency-target="loading" hidden><div class="main"><div class="body"><div class="panel"><div class="pad workspace-boot-pad"><span class="status-spinner"></span> Loading workspace…</div></div></div></div></div>
      ${resident}
    </div>`;
  }

  async function projectById(id: string): Promise<ProjectSummary> {
    const { projects } = await listProjects();
    const project = projects.find((candidate) => candidate.id === id);
    if (!project) throw new AtelierCoreError("project_not_found", `project not found: ${id}`);
    return project;
  }

  async function renderProjectLaunchModals(): Promise<string> {
    const { projects } = await listProjects();
    const selectedModel = await preferredNewAgentModel();
    return [
      await launchEmptyAgentModal(selectedModel),
      ...(await Promise.all(projects.map((project) => launchProjectAgentModal(project, selectedModel)))),
      ...projects.map((project) => deleteProjectModal(project)),
    ].join("");
  }

  async function renderWorkspaceShell(selectedId?: string, options: { mainHtml?: string; showWhatsNew?: boolean } = {}): Promise<string> {
    return `<div class="app workspace-shell" data-controller="workspace-shell atelier-shortcuts">
    <aside class="workspace-shell-sidebar" data-workspace-shell-target="sidebar">${await renderWorkspaceSidebar()}</aside>
    <div class="workspace-shell-resizer" data-action="pointerdown->workspace-shell#startResize"></div>
    <main class="workspace-shell-main">${options.mainHtml ?? await workspaceDetailHostHtml(selectedId)}</main>
  </div>
  ${addProjectModal()}
  <div id="update_modal_host"></div>
  <div id="settings_modal_host"></div>
  <div id="onboarding_modal_host">${await renderOnboardingDialogIfNeeded()}</div>
  <div id="${workspaceCommandModalHostId}"></div>
  <div id="${projectLaunchModalsId}">${await renderProjectLaunchModals()}</div>`;
  }

  async function homePage(): Promise<Response> {
    const selected = registry.list().find((entry) => entry.phase !== "failed");
    return response(layout("Workspaces", await renderWorkspaceShell(selected?.id), selected?.id));
  }

  function requireWorkspace(id: string): WorkspaceEntry {
    const entry = registry.get(id);
    if (!entry) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
    return entry;
  }

  async function workspacePage(id: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    const url = new URL(request.url);
    if (url.searchParams.get("resident") === "1") return response(await workspaceResidentFor(entry, { visible: true }));
    return response(layout(workspaceTitle(entry), await renderWorkspaceShell(id), id));
  }

  // ---------------------------------------------------------------------------
  // Create / delete
  // ---------------------------------------------------------------------------

  function startWorkspaceProvisioning(id: string, options: { init?: import("@atelier/workspace").WorkspaceInitInstruction; context?: WorkspaceCreationContext; title?: string; fork?: { sourceWorkspaceId: string } } = {}): void {
    provisioning.seed(id);
    void (async () => {
      try {
        await deps.provisionWorkspace(id, { init: options.init, context: options.context, fork: options.fork });
        if (options.title) await setWorkspaceTitle(id, options.title);
        registry.setPhase(id, "ready");
        await broadcastWorkspaceReady(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`could not provision workspace ${id}: ${message}`);
        registry.setPhase(id, "failed", message);
        provisioning.apply({ workspaceId: id, id: "workspace.failed", label: "Workspace creation failed", status: "failed", error: message });
        const entry = registry.get(id);
        // No "visible" class in broadcasts: each client shows the resident
        // itself iff it is currently looking at this workspace.
        if (entry) broadcastShell(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
      }
    })();
  }

  type WorkspaceCreateSource = { type: "empty" } | { type: "project"; project: ProjectSummary } | { type: "init"; init: WorkspaceInitInstruction } | { type: "fork"; sourceWorkspaceId: string; init?: WorkspaceInitInstruction };

  function initForSource(source: WorkspaceCreateSource): WorkspaceInitInstruction | undefined {
    if (source.type === "project") return projectWorkspaceInit(source.project);
    if (source.type === "init" || source.type === "fork") return source.init;
    return undefined;
  }

  function forkForSource(source: WorkspaceCreateSource): { sourceWorkspaceId: string } | undefined {
    return source.type === "fork" ? { sourceWorkspaceId: source.sourceWorkspaceId } : undefined;
  }

  function agentContext(agent: AgentWorkspaceParameters | undefined): AgentWorkspaceParameters | undefined {
    const initialPrompt = agent?.initialPrompt?.trim() ?? "";
    if (!initialPrompt) return undefined;
    return { initialPrompt, model: agent?.model ?? "", thinkingLevel: agent?.thinkingLevel ?? "", attachmentDraft: agent?.attachmentDraft ?? "" };
  }

  function creationContext(source: WorkspaceCreateSource, agent: AgentWorkspaceParameters | undefined): WorkspaceCreationContext | undefined {
    const fork = forkForSource(source);
    const agentParameters = agentContext(agent);
    if (!fork && !agentParameters) return undefined;
    return { ...(fork ? { fork } : {}), ...(agentParameters ? { agent: agentParameters } : {}) };
  }

  function createWorkspaceFromCommand(command: { source: WorkspaceCreateSource; agent?: AgentWorkspaceParameters; title?: string }): { id: string } {
    const id = generateWorkspaceId();
    const init = initForSource(command.source);
    const title = command.title?.trim() ?? "";
    const context = creationContext(command.source, command.agent);
    const fork = forkForSource(command.source);
    registry.add(id, title || null, init, currentAtelierImageId);
    startWorkspaceProvisioning(id, { ...(init !== undefined ? { init } : {}), ...(context ? { context } : {}), ...(title ? { title } : {}), ...(fork ? { fork } : {}) });
    return { id };
  }

  function createWorkspaceEndpoint(url: URL, request: Request): Response {
    const { id } = createWorkspaceFromCommand({ source: { type: "empty" } });
    const location = new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString();
    if (wantsTurboStream(request)) {
      return turboStreamResponse(turboUpdateStream("workspaces_table_rows", renderWorkspaceRows()), { headers: { location } });
    }
    return Response.redirect(location, 303);
  }

  async function createAgentWorkspaceFromForm(request: Request, options: { project?: ProjectSummary } = {}): Promise<Response> {
    const form = await request.formData();
    const model = String(form.get("model") ?? "");
    const thinkingLevel = String(form.get("level") ?? "");
    await rememberAgentPreferredNewAgentModel(model, thinkingLevel);
    createWorkspaceFromCommand({
      source: options.project ? { type: "project", project: options.project } : { type: "empty" },
      agent: {
        initialPrompt: String(form.get("text") ?? ""),
        model,
        thinkingLevel,
        attachmentDraft: String(form.get("attachmentDraft") ?? ""),
      },
    });
    return turboStreamResponse(turboUpdateStream("workspaces_table_rows", renderWorkspaceRows()));
  }

  async function createEmptyAgentWorkspaceEndpoint(request: Request): Promise<Response> {
    return await createAgentWorkspaceFromForm(request);
  }

  type ApiCreateWorkspaceBody = {
    source?: { type?: unknown; project?: unknown };
    prompt?: unknown;
    agent?: { prompt?: unknown; initialPrompt?: unknown; model?: unknown; thinkingLevel?: unknown; attachmentDraft?: unknown };
  };

  async function readApiJson(request: Request): Promise<ApiCreateWorkspaceBody> {
    try {
      const body = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidArguments("JSON object body is required");
      const record = body as Record<string, unknown>;
      if (record.source !== undefined && (!record.source || typeof record.source !== "object" || Array.isArray(record.source))) throw invalidArguments("source must be an object");
      if (record.agent !== undefined && (!record.agent || typeof record.agent !== "object" || Array.isArray(record.agent))) throw invalidArguments("agent must be an object");
      return body as ApiCreateWorkspaceBody;
    } catch (error) {
      if (error instanceof AtelierCoreError) throw error;
      throw invalidArguments("valid JSON object body is required");
    }
  }

  function stringField(value: unknown, name: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw invalidArguments(`${name} must be a string`);
    return value.trim();
  }

  async function projectByReference(reference: string): Promise<ProjectSummary> {
    const { projects } = await listProjects();
    const byId = projects.find((project) => project.id === reference);
    if (byId) return byId;
    const byName = projects.filter((project) => project.name === reference);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) throw invalidArguments(`project name is ambiguous: ${reference}`);
    throw new AtelierCoreError("project_not_found", `project not found: ${reference}`);
  }

  async function createWorkspaceApiEndpoint(request: Request, url: URL): Promise<Response> {
    try {
      const body = await readApiJson(request);
      const sourceType = stringField(body.source?.type, "source.type") ?? "empty";
      if (sourceType !== "empty" && sourceType !== "project") throw invalidArguments("source.type must be empty or project");
      const projectReference = stringField(body.source?.project, "source.project");
      let source: WorkspaceCreateSource = { type: "empty" };
      if (sourceType === "project") {
        if (!projectReference) throw invalidArguments("source.project is required for project workspaces");
        source = { type: "project", project: await projectByReference(projectReference) };
      }

      const prompt = stringField(body.agent?.initialPrompt ?? body.agent?.prompt ?? body.prompt, "prompt") ?? "";
      const model = stringField(body.agent?.model, "agent.model") ?? "";
      const thinkingLevel = stringField(body.agent?.thinkingLevel, "agent.thinkingLevel") ?? "";
      const attachmentDraft = stringField(body.agent?.attachmentDraft, "agent.attachmentDraft") ?? "";
      const { id } = createWorkspaceFromCommand({ source, agent: { initialPrompt: prompt, model, thinkingLevel, attachmentDraft } });

      const workspaceUrl = new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString();
      return jsonResponse({ workspace: { id, url: workspaceUrl, phase: "starting" } }, { status: 202, headers: { location: workspaceUrl } });
    } catch (error) {
      return problemJsonResponse(error);
    }
  }

  async function createWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceCreateRequest): Promise<AgentWorkspaceCreateResult> {
    const source: WorkspaceCreateSource = request.seedWithCurrentProjectClone
      ? (() => {
          const entry = registry.get(workspaceId);
          if (!isGitProjectInit(entry?.init)) throw invalidArguments("current workspace was not seeded from a project git clone");
          return { type: "init", init: entry.init };
        })()
      : { type: "empty" };
    const { id } = createWorkspaceFromCommand({ source, title: request.title, agent: request });
    return { id, url: `/workspaces/${encodeURIComponent(id)}`, phase: "starting" };
  }

  async function forkCurrentWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceForkRequest): Promise<AgentWorkspaceCreateResult> {
    const title = request.title.trim();
    if (!title) throw invalidArguments("title is required");
    const entry = registry.get(workspaceId);
    if (!entry || entry.phase !== "ready") throw new AtelierCoreError("workspace_not_found", `workspace not found: ${workspaceId}`);
    const { id } = createWorkspaceFromCommand({ source: { type: "fork", sourceWorkspaceId: workspaceId, init: entry.init }, title, agent: request });
    return { id, url: `/workspaces/${encodeURIComponent(id)}`, phase: "starting" };
  }

  async function createProjectAgentWorkspaceEndpoint(projectId: string, request: Request): Promise<Response> {
    const project = await projectById(projectId);
    const accessProblem = await githubRepoAccessProblem(project);
    if (accessProblem) return turboStreamResponse(turboUpdateStream(workspaceCommandModalHostId, githubRepoAccessProblemModal(project, accessProblem)));
    return await createAgentWorkspaceFromForm(request, { project });
  }

  async function broadcastWorkspaceReady(id: string): Promise<void> {
    try {
      // No "visible" class in broadcasts: each client shows the resident
      // itself iff it is currently looking at this workspace.
      broadcastShell(turboReplaceStream(workspaceBootId(id), await workspaceDetailResidentHtml(id)));
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

  function canDeleteWorkspace(entry: WorkspaceEntry): boolean {
    return entry.phase === "ready" || entry.phase === "failed";
  }

  async function inspectAndScheduleWorkspaceDeletion(id: string, force: boolean): Promise<{ deleted: boolean; blocked: boolean; details?: WorkspaceDeleteBlockedDetails }> {
    const entry = requireWorkspace(id);
    if (!canDeleteWorkspace(entry)) throw new AtelierCoreError("workspace_not_ready", `workspace ${id} is not ready for deletion`);
    if (entry.phase === "failed") {
      scheduleWorkspaceDeletion(id);
      return { deleted: true, blocked: false };
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
        return { deleted: false, blocked: true, details };
      }
    }
    scheduleWorkspaceDeletion(id);
    return { deleted: true, blocked: false };
  }

  function deleteCurrentWorkspaceFromAgent(id: string, force: boolean): Promise<{ deleted: boolean; blocked: boolean; details?: WorkspaceDeleteBlockedDetails }> {
    return inspectAndScheduleWorkspaceDeletion(id, force);
  }

  async function deleteWorkspaceEndpoint(id: string, force: boolean): Promise<Response> {
    const entry = requireWorkspace(id);
    if (!canDeleteWorkspace(entry)) {
      // Already starting/deleting: nothing sensible to do.
      return turboStreamResponse(turboRemoveStream("delete-workspace-modal"), { status: 409 });
    }

    const result = await inspectAndScheduleWorkspaceDeletion(id, force);
    if (result.blocked) {
      return turboStreamResponse(`${turboRemoveStream("delete-workspace-modal")}${turboStream("append", "body", deleteBlockedModal(id, result.details!))}`);
    }
    return turboStreamResponse(turboRemoveStream("delete-workspace-modal"));
  }

  function parkWorkspaceEndpoint(id: string, parked: boolean, request: Request): Response {
    const entry = requireWorkspace(id);
    if (entry.phase !== "ready") return wantsTurboStream(request) ? turboStreamResponse("", { status: 409 }) : response("Workspace is not ready", { status: 409 });
    registry.setParked(id, parked);
    if (wantsTurboStream(request)) return turboStreamResponse(turboUpdateStream("workspaces_table_rows", renderWorkspaceRows()));
    return Response.redirect(request.headers.get("referer") ?? "/", 303);
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
    return response(workspaceSidebarTitleFrame(entry));
  }

  async function updateWorkspaceSidebarTitleFromForm(id: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    const formData = await request.formData();
    const title = String(formData.get("title") ?? "").trim();
    await setWorkspaceTitle(id, title);
    registry.setTitle(id, title || null);
    return response(workspaceSidebarTitleFrame(entry));
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  async function createProjectFromForm(request: Request, url: URL): Promise<Response> {
    const formData = await request.formData();
    const gitUrl = String(formData.get("gitUrl") ?? "");
    await addProject(gitUrl);
    return Response.redirect(new URL("/", url).toString(), 303);
  }

  function projectReferencingWorkspaces(projectId: string): WorkspaceEntry[] {
    return registry.list().filter((entry) => isGitProjectInit(entry.init) && entry.init.projectId === projectId);
  }

  function deleteProjectBlockedModal(project: ProjectSummary, references: WorkspaceEntry[]): string {
    const count = references.length;
    return `<dialog id="delete-project-blocked-modal" class="modal project-delete-blocked-modal" data-controller="modal" data-modal-auto-show-value="true">
  <form method="dialog">
    <div class="modal-header project-delete-header">
      <div class="modal-icon warning" aria-hidden="true">!</div>
      <div>
        <h2>Project is in use</h2>
        <p><b>${escapeHtml(project.name)}</b> is referenced by ${count === 1 ? "1 workspace" : `${count} workspaces`}.</p>
      </div>
    </div>
    <div class="project-delete-workspaces" aria-label="Referencing workspaces">
      ${references.map((entry) => `<div class="project-delete-workspace">${repoSwatch(project.id)}<span class="project-delete-workspace-title">${escapeHtml(workspaceTitle(entry))}</span><span class="project-delete-workspace-id">${escapeHtml(entry.id)}</span></div>`).join("")}
    </div>
    <p class="project-delete-help">Delete these workspaces first, then try deleting the project again.</p>
    <div class="modal-actions"><button class="btn primary" value="close">OK</button></div>
  </form>
</dialog>`;
  }

  async function deleteProjectEndpoint(projectId: string): Promise<Response> {
    const project = await projectById(projectId);
    const references = projectReferencingWorkspaces(projectId);
    if (references.length > 0) {
      return turboStreamResponse(`${turboUpdateStream(projectLaunchModalsId, await renderProjectLaunchModals())}${turboUpdateStream(workspaceCommandModalHostId, deleteProjectBlockedModal(project, references))}`);
    }
    await deleteProject(projectId);
    return turboStreamResponse([
      turboReplaceStream("workspace_sidebar", await renderWorkspaceSidebar()),
      turboUpdateStream(projectLaunchModalsId, await renderProjectLaunchModals()),
      turboUpdateStream(workspaceCommandModalHostId, ""),
    ].join(""));
  }

  async function githubRepositorySearchEndpoint(url: URL): Promise<Response> {
    const query = url.searchParams.get("q") ?? "";
    try {
      const repositories = shouldSearchGitHubRepositories(query) ? await searchGitHubRepositories(query) : [];
      return new Response(renderGitHubRepositorySearchMenu(repositories, query), { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      if (error instanceof GitHubRepositorySearchRateLimitError) return new Response(renderGitHubRepositorySearchRateLimitMenu(error), { status: 429, headers: { "content-type": "text/html; charset=utf-8" } });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Group / tab layout endpoints (requester-only streams; no cross-user sync)
  // ---------------------------------------------------------------------------

  async function replaceWorkspaceGroupsTurboStream(workspaceId: string): Promise<string> {
    return turboStream("replace", workspaceGroupsId(workspaceId), await renderWorkspaceGroupsFor(workspaceId));
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
    const commands = (await workspaceTabsAndAttachments(workspaceId)).attachments.flatMap((attachment) => attachment.commands ?? []);
    if (!commands.some((command: WorkspaceCommandContribution) => command.id === commandId)) {
      throw new AtelierCoreError("command_not_found", `workspace command not found: ${commandId}`);
    }
  }

  function workspaceModuleCommands(): WorkspaceModuleCommandHandler[] {
    return workspaceModules.flatMap((module) => module.commands ?? []);
  }

  function workspaceModuleRoutes(): WorkspaceModuleRouteHandler[] {
    return workspaceModules.flatMap((module) => module.routes ?? []);
  }

  function workspaceModuleTabLifecycles(): WorkspaceModuleTabLifecycleHandler[] {
    return workspaceModules.flatMap((module) => module.tabs ?? []);
  }

  async function executeWorkspaceCommand(workspaceId: string, commandId: string): Promise<WorkspaceModuleCommandResult> {
    await assertWorkspaceCommandExists(workspaceId, commandId);
    const command = workspaceModuleCommands().find((candidate) => candidate.id === commandId);
    if (!command) throw new AtelierCoreError("command_not_implemented", `workspace command not implemented: ${commandId}`);
    return await command.execute({ workspaceId, events: deps.events, tabKeys: () => tabKeysFor(workspaceId), layouts });
  }

  function workspaceGroupsTurboStream(workspaceId: string, tabs: WorkspaceTabContribution[], attachments: WorkspaceAttachment[]): string {
    return turboReplaceStream(workspaceGroupsId(workspaceId), renderWorkspaceGroups(workspaceId, tabs, attachments));
  }

  function placeCommandTab(workspaceId: string, tabKeys: string[], result: WorkspaceModuleCommandResult, fallbackGroupId?: string): void {
    if (!result.createdTabKey) return;
    if (result.tabPlacement === "preview-group") {
      layouts.ensureTabInPreviewGroup(workspaceId, tabKeys, result.createdTabKey);
      return;
    }
    if (fallbackGroupId) layouts.placeNewTab(workspaceId, tabKeys, fallbackGroupId, result.createdTabKey);
  }

  async function workspaceGroupCommandEndpoint(workspaceId: string, groupId: string, commandId: string): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId);
    const { attachments, tabs } = await workspaceTabsAndAttachments(workspaceId);
    placeCommandTab(workspaceId, tabs.map((tab) => tab.key), result, groupId);
    return turboStreamResponse(`${workspaceGroupsTurboStream(workspaceId, tabs, attachments)}${result.streamHtml ?? ""}`);
  }

  async function workspaceCommandEndpoint(workspaceId: string, commandId: string): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId);
    if (!result.createdTabKey) return turboStreamResponse(result.streamHtml ?? "");

    const { attachments, tabs } = await workspaceTabsAndAttachments(workspaceId);
    const tabKeys = tabs.map((tab) => tab.key);
    const groupId = layouts.normalize(workspaceId, tabKeys).groups.find((group) => group.visibleTab)?.id;
    placeCommandTab(workspaceId, tabKeys, result, groupId);
    return turboStreamResponse(`${workspaceGroupsTurboStream(workspaceId, tabs, attachments)}${result.streamHtml ?? ""}`);
  }

  async function closeWorkspaceTabEndpoint(workspaceId: string, tab: string): Promise<Response> {
    await Promise.all(workspaceModuleTabLifecycles()
      .filter((lifecycle) => lifecycle.owns(tab))
      .map((lifecycle) => lifecycle.close?.({ workspaceId, tabKey: tab })));
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
    const body = await request.json().catch(() => undefined) as { visibleTab?: unknown; groupId?: unknown } | undefined;
    const visibleTab = typeof body?.visibleTab === "string" ? body.visibleTab : undefined;
    const groupId = typeof body?.groupId === "string" ? body.groupId : undefined;
    if (visibleTab && groupId) layouts.setVisibleTab(id, groupId, visibleTab);
    return jsonResponse({ ok: true });
  }

  function activeWorkspaceEndpoint(id: string): Response {
    requireWorkspace(id);
    registry.setActiveWorkspace(id);
    return turboStreamResponse("");
  }

  function clearActiveWorkspaceEndpoint(): Response {
    registry.setActiveWorkspace(undefined);
    return turboStreamResponse("");
  }


  function openOldestUnreadWorkspaceEndpoint(): Response {
    const entry = registry.oldestUnreadWorkspace();
    if (!entry) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return turboStreamResponse("", { headers: { location: `/workspaces/${encodeURIComponent(entry.id)}` } });
  }

  deps.events?.on("workspace_tabs_changed", ({ workspaceId }) => {
    void replaceWorkspaceGroupsTurboStream(workspaceId)
      .then((html) => broadcastShell(html))
      .catch((error) => logError(`could not broadcast workspace tab changes for ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`));
  });

  // ---------------------------------------------------------------------------
  // Errors + routing
  // ---------------------------------------------------------------------------

  function errorPage(error: unknown): Response {
    const status = error instanceof AtelierCoreError && ["workspace_not_found", "project_not_found", "repo_not_found", "terminal_not_found", "agent_not_found"].includes(error.code) ? 404 : 500;
    const message = error instanceof Error ? error.message : String(error);
    return response(layout("Error", `<div class="app no-sidebar"><div class="main"><header class="header"><h1>Error</h1></header><div class="body"><p>${escapeHtml(message)}</p><p><a class="btn" href="/">Back home</a></p></div></div></div>`), { status });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/up" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : "ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const page = await homePage();
      return request.method === "HEAD" ? new Response(null, { status: page.status, statusText: page.statusText, headers: page.headers }) : page;
    }
    if (url.pathname === "/api/workspaces" && request.method === "POST") return await createWorkspaceApiEndpoint(request, url);
    if (url.pathname === "/workspaces" && request.method === "GET") return Response.redirect(new URL("/", url).toString(), 302);
    if (url.pathname === "/workspaces" && request.method === "POST") return createWorkspaceEndpoint(url, request);
    if (url.pathname === "/workspaces/open-oldest-unread" && request.method === "POST") return openOldestUnreadWorkspaceEndpoint();
    if (url.pathname === "/workspaces/active/clear" && request.method === "POST") return clearActiveWorkspaceEndpoint();
    if (url.pathname === "/projects" && request.method === "POST") return await createProjectFromForm(request, url);
    if (url.pathname === "/projects/github-search" && request.method === "GET") return await githubRepositorySearchEndpoint(url);

    const match = (pattern: RegExp): string[] | undefined => {
      const result = url.pathname.match(pattern);
      return result ? result.slice(1).map(decodeURIComponent) : undefined;
    };

    const settingsResponse = await handleSettingsRequest(request, url, { forceDeleteAllWorkspaces: forceDeleteAllWorkspacesFromSettings });
    if (settingsResponse) return settingsResponse;

    const onboardingResponse = await handleOnboardingRequest(request, url);
    if (onboardingResponse) return onboardingResponse;

    for (const moduleRoute of workspaceModuleRoutes()) {
      const moduleResponse = await moduleRoute.handle(request, url, { events: deps.events });
      if (moduleResponse) return moduleResponse;
    }

    let params: string[] | undefined;

    if ((params = match(/^\/projects\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectEndpoint(params[0]);

    if (url.pathname === "/agent-workspaces" && request.method === "POST") return await createEmptyAgentWorkspaceEndpoint(request);
    if ((params = match(/^\/project-agent-workspaces\/([^/]+)$/)) && request.method === "POST") return await createProjectAgentWorkspaceEndpoint(params[0], request);

    if ((params = match(/^\/workspaces\/([^/]+)\/sidebar-title\/edit$/)) && request.method === "GET") return workspaceSidebarTitleEditFrame(params[0]);
    if ((params = match(/^\/workspaces\/([^/]+)\/sidebar-title$/))) {
      if (request.method === "GET") return workspaceSidebarTitleShowFrame(params[0]);
      if (request.method === "POST") return await updateWorkspaceSidebarTitleFromForm(params[0], request);
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/view-state$/)) && request.method === "POST") return await updateWorkspaceViewStateEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/active$/)) && request.method === "POST") return activeWorkspaceEndpoint(params[0]);
    if ((params = match(/^\/workspaces\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") return await workspaceCommandEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") return await workspaceGroupCommandEndpoint(params[0], params[1], params[2]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/split$/)) && request.method === "POST") return await splitWorkspaceGroupEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/remove$/)) && request.method === "POST") return await removeWorkspaceGroupEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/close$/)) && request.method === "POST") return await closeWorkspaceGroupEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/tabs\/([^/]+)\/close$/)) && request.method === "POST") return await closeWorkspaceTabEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/layout\/move-tab$/)) && request.method === "POST") return await moveWorkspaceTabEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/tabs\/(.+)\/close$/)) && request.method === "POST") return await closeWorkspaceTabEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/layout\/resize$/)) && request.method === "POST") return await resizeWorkspaceGroupsEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/park$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], true, request);
    if ((params = match(/^\/workspaces\/([^/]+)\/unpark$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], false, request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteWorkspaceEndpoint(params[0], url.searchParams.get("force") === "1");
    if ((params = match(/^\/workspaces\/([^/]+)$/)) && request.method === "GET") return await workspacePage(params[0], request);

    return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return {
    shellSnapshot: initialStatusStreams,
    tabKeysFor,
    deleteCurrentWorkspaceFromAgent,
    createWorkspaceFromAgent,
    forkCurrentWorkspaceFromAgent,
    workspaceRowContributions,
    globalSidebarContributions,
    async fetch(request) {
      try {
        return await route(request);
      } catch (error) {
        return errorPage(error);
      }
    },
  };
}
