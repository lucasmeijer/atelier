import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  workspaceAgentConversationContributions,
  renderAgentComposer,
  renderAgentLaunchSettings,
  rememberNewWorkspaceAgentSettings,
} from "@atelier/agent/server";
import {
  AtelierCoreError,
  gitHubCredentialHelperCommand,
  invalidArguments,
  isJsonObject,
  readJsonObject,
  requestAcceptsJson,
  type AtelierEventBus,
  type JsonObject,
  type JsonValue,
} from "@atelier/core";
import { discoverHostGitHubToken, hasWorkspaceGitHubToken } from "@atelier/proxy-egress";
import {
  addProject,
  createProjectEnvironmentVariable,
  createProjectSecret,
  deleteProject,
  deleteProjectEnvironmentVariable,
  deleteProjectSecret,
  deleteProjectSshKey,
  formatProjectSpec,
  isGitProjectInit,
  listProjectEnvironmentVariables,
  listProjectSecrets,
  hasProjectSshKey,
  listProjects,
  parseProjectSpec,
  projectWorkspaceInit,
  updateProject,
  updateProjectEnvironmentVariable,
  updateProjectSecret,
  setProjectSshKey,
  type ProjectEnvironmentVariable,
  type ProjectSecretSummary,
  type ProjectSummary,
  type WorkspaceDeleteBlockedDetails,
} from "@atelier/projects";
import { createWorkspacePresentationStore, generateWorkspaceId, listWorkspaces, setWorkspaceParked, setWorkspaceTitle, type WorkspaceCreationContext, type WorkspaceInitInstruction, type WorkspaceWorkViewReference, type WorkspaceWorkViewState } from "@atelier/workspace";
import { createWorkspaceProvisioningStore } from "@atelier/workspace/server/provisioning";
import {
  atelierName,
  CableTopics,
  emptyWorkspaceCommandInputSchema,
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
  type WorkspaceModuleCommandHandler,
  type WorkspaceModuleCommandResult,
  type WorkspaceModuleRouteHandler,
  type WorkspaceModuleWorkViewAdapter,
  type WorkspaceServerProvisioningHook,
  type WorkspaceAgentConversationPresentation,
  type WorkspaceWorkViewPresentation,
} from "@atelier/shared";
import type { WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceModules } from "./workspace-modules.ts";
import { handleSettingsRequest, renderSettingsDialog } from "./settings/routes.ts";
import { handleOnboardingRequest, renderOnboardingDialogIfNeeded } from "./onboarding/routes.ts";
import { GitHubRepositorySearchRateLimitError, renderGitHubRepositorySearchMenu, renderGitHubRepositorySearchRateLimitMenu, searchGitHubRepositories, shouldSearchGitHubRepositories } from "./github-repo-search.ts";
import { atelierOpenApi } from "./openapi.ts";
import { parseCloseWorkViewRequest, parseReorderWorkViewRequest } from "./work-view-api.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { openWorkViewTurboStream, presentWorkViewTurboStream, removeWorkspaceResidentTurboStream, renderWorkspacePane, renderWorkspacePresentation, workspacePaneCollectionsTurboStream, workspacePaneOnboardingState, workspacePresentationTurboStream, type AgentPaneContribution, type WorkPaneContribution, type WorkspacePaneEntry, type WorkspacePanePresentation, type WorkspacePresentation as FixedWorkspacePresentation } from "./workspace-presentation.ts";

const jsonStringSchema = Type.String();

export interface WebAppDeps {
  registry: WorkspaceRegistry;
  cable?: { broadcast(identifier: CableIdentifier, html: string): void };
  /** Event bus passed through to the agent module routes. */
  events?: AtelierEventBus;
  devReload?: boolean;
  /** Create the container + default agent etc. for an already-registered workspace id. */
  provisionWorkspace(id: string, options?: { init?: import("@atelier/workspace").WorkspaceInitInstruction; context?: WorkspaceCreationContext; fork?: { sourceWorkspaceId: string } }): Promise<void>;
  inspectDeleteSafety(id: string): Promise<WorkspaceDeleteBlockedDetails>;
  /** Force-remove the workspace container. */
  destroyWorkspace(id: string): Promise<void>;
  /** Persist parked state and stop or start its workspace container. Defaults to setWorkspaceParked. */
  persistWorkspaceParked?(id: string, parked: boolean): Promise<void>;
  /** Receives background task failures. Defaults to console.error. */
  logError?(message: string): void;
  provisioningHooks: WorkspaceServerProvisioningHook[];
  workspaceRemovedHandlers?: Array<(workspaceId: string) => void | Promise<void>>;
}

export interface WebApp {
  fetch(request: Request): Promise<Response>;
  shellSnapshot(): Promise<string>;
  deleteCurrentWorkspaceFromAgent(workspaceId: string, force: boolean): Promise<{ deleted: boolean; blocked: boolean; details?: WorkspaceDeleteBlockedDetails }>;
  createWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceCreateRequest): Promise<AgentWorkspaceCreateResult>;
  forkCurrentWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceForkRequest): Promise<AgentWorkspaceCreateResult>;
  presentWorkViewFromAgent(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  globalSidebarContributions: GlobalSidebarContributionRegistry;
}

type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };
interface WorkspaceCommandResponse { id: string; workView?: WorkspaceWorkViewReference; agentConversationId?: string }

function response(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(body, { ...init, headers });
}

function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

function jsonResponse<Body extends object>(body: Body, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function problemJsonResponse(error: Error): Response {
  const status = error instanceof AtelierCoreError && ["invalid_arguments", "invalid_git_url"].includes(error.code) ? 400
    : error instanceof AtelierCoreError && ["project_not_found", "project_environment_variable_not_found", "project_secret_not_found", "workspace_not_found", "command_not_found", "agent_conversation_not_found", "view_not_found", "terminal_not_found"].includes(error.code) ? 404
      : 500;
  const message = error.message;
  const code = error instanceof AtelierCoreError ? error.code : "internal_error";
  const details = error instanceof AtelierCoreError ? error.details : undefined;
  return jsonResponse({ error: { code, message, ...(details ?? {}) } }, { status });
}

function turboReplaceStream(target: string, html: string): string {
  return turboStream("replace", target, html);
}

function turboRemoveStream(target: string): string {
  return turboStream("remove", target);
}

function selectWorkspaceTurboStream(workspaceId: string): string {
  return `<turbo-stream action="select-workspace" target="workspace_detail" data-workspace-id="${escapeHtml(workspaceId)}"></turbo-stream>`;
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
  // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
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
  const { registry } = deps;
  const logError = deps.logError ?? ((message: string) => console.error(message));
  const versionTooltip = atelierVersionTooltip();
  // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
  const workViewAdapters = workspaceModules.flatMap((module) => module.workViews ?? []) as WorkspaceModuleWorkViewAdapter[];
  const presentationStore = createWorkspacePresentationStore({
    workViewContributions: workViewAdapters,
    agentConversations: workspaceAgentConversationContributions,
  });

  function broadcastShell(html: string): void {
    deps.cable?.broadcast(CableTopics.shell(), html);
  }

  const provisioning = createWorkspaceProvisioningStore({ onChange: (workspaceId) => broadcastWorkspaceBoot(workspaceId), seedSteps: deps.provisioningHooks });
  const workspaceCommandModalHostId = "workspace_command_modal_host";
  const agentLaunchModalFrameId = "agent_launch_modal";
  // Every server-rendered launch form has one attachment draft ID. Retried POSTs
  // therefore join the original launch instead of provisioning another workspace.
  const agentWorkspaceLaunches = new Map<string, Promise<CreatedWorkspace>>();
  const agentLaunchSettingsFrameId = "agent_launch_settings";
  const agentLaunchFormId = "agent_launch_form";

  function workspaceBootId(id: string): string {
    return domId("workspace_boot", id);
  }

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

  const persistWorkspaceParked = deps.persistWorkspaceParked ?? setWorkspaceParked;
  let suppressParkedStateCallbacks = false;

  async function refreshWorkspacePaneCollections(): Promise<string> {
    const pane = await workspacePaneCollections("");
    const stream = `${workspacePaneCollectionsTurboStream(pane)}${turboReplaceStream(emptyWorkspaceOnboardingId, emptyWorkspaceOnboardingHtml(pane))}`;
    broadcastShell(stream);
    return stream;
  }

  function broadcastWorkspacePaneCollections(): void {
    void refreshWorkspacePaneCollections().catch((error) => logError(`could not refresh Workspace pane: ${error instanceof Error ? error.message : String(error)}`));
  }

  registry.setCallbacks({
    rowChanged(entry) {
      if (entry.phase === "deleting") broadcastShell(removeWorkspaceResidentTurboStream(entry.id));
      broadcastWorkspacePaneCollections();
    },
    listChanged() {
      if (suppressParkedStateCallbacks) return;
      broadcastWorkspacePaneCollections();
    },
    parkedChanged(entry) {
      if (suppressParkedStateCallbacks) return;
      void persistWorkspaceParked(entry.id, entry.parked).catch((error) => logError(`could not persist parked state for workspace ${entry.id}: ${error instanceof Error ? error.message : String(error)}`));
    },
    removed(id) {
      provisioning.delete(id);
      for (const handler of deps.workspaceRemovedHandlers ?? []) void handler(id);
    },
  });

  // ---------------------------------------------------------------------------
  // Page shell
  // ---------------------------------------------------------------------------

  function moduleStylesHtml(): string {
    const styles = new Set<string>();
    for (const module of workspaceModules) {
      for (const [path, entry] of Object.entries(module.staticFiles ?? {})) {
        if (path.endsWith(".css") && entry.contentType.toLowerCase().startsWith("text/css")) styles.add(path);
      }
    }
    return [...styles].map((path) => `<link rel="stylesheet" href="${assetPath(path)}">`).join("\n");
  }

  function layout(title: string, body: string, workspaceId?: string): string {
    if (deps.devReload) cachedAssetManifest = loadAssetManifest();
    const pageId = randomUUID();
    return `<!DOCTYPE html>
<html lang="en" data-theme="nord" data-atelier-page-id="${escapeHtml(pageId)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
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
<script type="module" src="${assetPath("/workspace.js")}"></script>
</head>
<body id="body" data-controller="cable-shell${deps.devReload ? " dev-reload" : ""}"${deps.devReload ? ` data-dev-reload-url-value="/__atelier_dev_reload"` : ""}>${body}
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

  async function agentLaunchSettingsFrame(selectedModel?: string): Promise<string> {
    return await renderAgentLaunchSettings({
      frameId: agentLaunchSettingsFrameId,
      formId: agentLaunchFormId,
      url: "/agent-launch/settings",
      selectedModel,
    });
  }

  async function launchAgentWorkspaceFrame(options: { titleHtml: string; action: string }): Promise<string> {
    const draftId = crypto.randomUUID();
    return `<turbo-frame id="${agentLaunchModalFrameId}"><dialog class="agent-launch-modal" data-controller="agent-launch-dialog submit-shortcut" data-agent-launch-dialog-discard-url-value="/agent-attachment-drafts/${encodeURIComponent(draftId)}/discard">
  <div class="agent-launch-title">${options.titleHtml}</div>
  ${await renderAgentComposer({
    action: options.action,
    draftId,
    formId: agentLaunchFormId,
    placeholder: "Describe what you want the agent to do… (optional)",
    initialText: "",
    submitLabel: "Create workspace",
    submitShortcut: "⌘↩",
    rows: 8,
    formActions: "keydown->submit-shortcut#keydown submit->submit-shortcut#submit turbo:submit-end->submit-shortcut#submitted",
    formTurbo: true,
    launchSettings: { frameId: agentLaunchSettingsFrameId, url: "/agent-launch/settings" },
  })}
</dialog></turbo-frame>`;
  }

  async function launchEmptyAgentFrame(): Promise<string> {
    return await launchAgentWorkspaceFrame({
      titleHtml: "Create empty workspace, and then…",
      action: "/agent-workspaces",
    });
  }

  async function launchProjectAgentFrame(project: ProjectSummary): Promise<string> {
    return await launchAgentWorkspaceFrame({
      titleHtml: `Create workspace from <b>${escapeHtml(project.name)}</b>, and then…`,
      action: `/project-agent-workspaces/${encodeURIComponent(project.id)}`,
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

  function projectEnvironmentRow(project: ProjectSummary, variable: ProjectEnvironmentVariable): string {
    return `<form class="project-configuration-row project-environment-row" role="row" method="post" action="/projects/${encodeURIComponent(project.id)}/environment/${encodeURIComponent(variable.id)}" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save">
    <input name="name" value="${escapeHtml(variable.name)}" aria-label="Name" autocomplete="off">
    <input name="value" value="${escapeHtml(variable.value)}" aria-label="Value" autocomplete="off">
    <span class="project-configuration-actions"><button type="submit" formaction="/projects/${encodeURIComponent(project.id)}/environment/${encodeURIComponent(variable.id)}/delete" title="Remove environment variable" aria-label="Remove environment variable">×</button></span>
  </form>`;
  }

  function projectEnvironmentEditor(project: ProjectSummary, environment: ProjectEnvironmentVariable[]): string {
    return `<section class="project-configuration-list project-environment" id="${domId("project_environment", project.id)}">
      <div class="project-configuration-head"><h3>Environment</h3><p>These variables are added to every new workspace container created for this project.</p></div>
      <div class="project-configuration-grid" role="table" aria-label="Environment variables">
        <div class="project-configuration-row project-environment-row head" role="row"><span>Name</span><span>Value</span><span></span></div>
        ${environment.map((variable) => projectEnvironmentRow(project, variable)).join("")}
        <form class="project-configuration-row project-environment-row new" role="row" method="post" action="/projects/${encodeURIComponent(project.id)}/environment" data-turbo="true">
          <input name="name" placeholder="ENV_VAR" aria-label="Name" autocomplete="off">
          <input name="value" placeholder="Value" aria-label="Value" autocomplete="off">
          <button type="submit" aria-label="Add">+</button>
        </form>
      </div>
    </section>`;
  }

  function projectSecretRow(project: ProjectSummary, secret: ProjectSecretSummary): string {
    return `<form class="project-configuration-row project-secret-row" role="row" method="post" action="/projects/${encodeURIComponent(project.id)}/secrets/${encodeURIComponent(secret.id)}" data-turbo="true" data-controller="settings-autosave" data-action="change->settings-autosave#save">
    <input name="envName" value="${escapeHtml(secret.envName)}" aria-label="Env" autocomplete="off">
    <input name="hostPattern" value="${escapeHtml(secret.hostPattern)}" aria-label="Host" autocomplete="off">
    <input name="placeholder" value="${escapeHtml(secret.placeholder ?? "")}" placeholder="Automatic" aria-label="Placeholder" autocomplete="off">
    <input name="secretValue" type="password" placeholder="Unchanged" aria-label="Secret" autocomplete="new-password">
    <span class="project-configuration-actions"><button type="submit" formaction="/projects/${encodeURIComponent(project.id)}/secrets/${encodeURIComponent(secret.id)}/delete" title="Remove secret" aria-label="Remove secret">×</button></span>
  </form>`;
  }

  function projectSecretEditor(project: ProjectSummary, secrets: ProjectSecretSummary[]): string {
    return `<section class="project-configuration-list project-secrets" id="${domId("project_secrets", project.id)}">
      <div class="project-configuration-head"><h3>Secrets</h3><p>Atelier injects a placeholder for ENV into workspaces, then replaces it with SECRET for matching HTTPS hosts. Set a custom placeholder when an API requires token-like values; leave it blank to generate one automatically.</p></div>
      <div class="project-configuration-grid" role="table" aria-label="Secrets">
        <div class="project-configuration-row project-secret-row head" role="row"><span>Env</span><span>Host</span><span>Placeholder</span><span>Secret</span><span></span></div>
        <div class="project-configuration-row project-secret-row readonly" role="row" aria-label="GitHub token injected automatically">
          <span class="project-builtin-token"><code>GH_TOKEN</code><small>Built in</small></span>
          <code>api.github.com</code>
          <span class="project-automatic-value">Automatic</span>
          <span class="project-automatic-value">Injected automatically</span>
          <span></span>
        </div>
        ${secrets.map((secret) => projectSecretRow(project, secret)).join("")}
        <form class="project-configuration-row project-secret-row new" role="row" aria-label="Add secret" method="post" action="/projects/${encodeURIComponent(project.id)}/secrets" data-turbo="true">
          <input name="envName" placeholder="ENV_VAR" aria-label="Env" autocomplete="off">
          <input name="hostPattern" placeholder="api.example.com or *.example.com" aria-label="Host" autocomplete="off">
          <input name="placeholder" placeholder="Optional token-like value" aria-label="Placeholder" autocomplete="off">
          <input name="secretValue" type="password" placeholder="Secret" aria-label="Secret" autocomplete="new-password">
          <button type="submit" aria-label="Add">+</button>
        </form>
      </div>
    </section>`;
  }

  function projectSshKeyEditor(project: ProjectSummary, configured: boolean): string {
    const action = `/projects/${encodeURIComponent(project.id)}/ssh-key`;
    return `<section class="project-configuration-list project-ssh-key" id="${domId("project_ssh_key", project.id)}">
      <div class="project-configuration-head"><h3>SSH key</h3><p>The private key stays on the Atelier host. Workspaces receive only an SSH agent socket, so <code>ssh</code> can authenticate to servers that list the public key in <code>authorized_keys</code> without exposing the private key.</p></div>
      <form class="project-ssh-key-form" method="post" action="${action}" data-turbo="true">
        <label><span>${configured ? "Replace private key" : "Private key"}</span><textarea name="privateKey" placeholder="${configured ? "Leave blank to keep the current key" : "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA…\n-----END OPENSSH PRIVATE KEY-----"}" autocomplete="off"${configured ? "" : " required"}></textarea></label>
        <div class="project-ssh-key-command"><span>Create an unencrypted Ed25519 key:</span><code>ssh-keygen -t ed25519 -f ~/.ssh/atelier_deploy -N '' -C atelier-deploy</code><span>Paste <code>~/.ssh/atelier_deploy</code> here and add <code>~/.ssh/atelier_deploy.pub</code> to the server’s <code>authorized_keys</code>.</span></div>
        <div class="project-ssh-key-actions"><small>The private key is encrypted at rest.</small><button class="btn primary" type="submit">${configured ? "Save" : "Add SSH key"}</button>${configured ? `<button class="btn danger" type="submit" formaction="${action}/delete">Remove</button>` : ""}</div>
      </form>
    </section>`;
  }

  async function projectEditorFrame(project: ProjectSummary): Promise<string> {
    const [environment, secrets, hasSshKey] = await Promise.all([listProjectEnvironmentVariables(project.id), listProjectSecrets(project.id), hasProjectSshKey(project.id)]);
    return `<turbo-frame id="project_editor_frame" class="project-editor-frame">
      <div class="project-editor-page project-editor-detail-page">
        <header class="project-editor-detail-head"><div><small>Project settings</small><h2>${escapeHtml(project.name)}</h2></div><button type="button" aria-label="Close" data-action="modal#close">×</button></header>
        <div class="project-editor-detail-body">
          <section class="project-edit-section"><div class="project-edit-section-copy"><h3>Repository</h3><p>How this project appears and where new workspaces are cloned from.</p></div><form class="project-edit-form" aria-label="Repository" method="post" action="/projects/${encodeURIComponent(project.id)}" data-controller="settings-autosave" data-action="change->settings-autosave#save"><label class="project-edit-field"><span>Display name</span><input class="modal-input" name="name" value="${escapeHtml(project.name)}" required></label><label class="project-edit-field"><span>Repository source</span><input class="modal-input" name="gitUrl" value="${escapeHtml(formatProjectSpec(project))}" required></label></form></section>
          <div class="project-edit-config"><div class="project-edit-section-copy"><h3>Workspace configuration</h3><p>Applied whenever a workspace is created from this project.</p></div>${projectEnvironmentEditor(project, environment)}${projectSecretEditor(project, secrets)}${projectSshKeyEditor(project, hasSshKey)}</div>
          <section class="project-edit-danger"><div><h3>Delete project</h3><p>Existing workspaces must be deleted first.</p></div><button class="btn danger" type="button" data-controller="modal-opener" data-action="modal#close modal-opener#open" data-modal-opener-target-id-value="${domId("delete_project_modal", project.id)}">Delete project</button></section>
        </div>
      </div>
    </turbo-frame>`;
  }

  function newProjectEditorFrame(): string {
    return `<turbo-frame id="project_editor_frame" class="project-editor-frame"><div class="project-editor-page project-editor-detail-page"><header class="project-editor-detail-head"><div><small>Add project</small><h2>New project</h2></div><button type="button" aria-label="Close" data-action="modal#close">×</button></header><form class="project-editor-new-form" aria-label="Add project" method="post" action="/projects" data-turbo="true" data-action="turbo:submit-end->modal#submitted"><div><h3>Repository source</h3><p>Save a remote URL, local path, or search for a GitHub repository.</p><div class="project-github-search" data-controller="project-github-search" data-project-github-search-url-value="/projects/github-search"><input class="modal-input" name="gitUrl" placeholder="github.com/org/repo, or /path/to/repo#branch" required autofocus data-project-github-search-target="input" data-action="keydown->project-github-search#keydown input->project-github-search#input"><div class="agent-completion-menu-host project-github-search-menu" data-project-github-search-target="menu" hidden></div></div></div><footer><button class="btn" type="button" data-action="modal#close">Cancel</button><button class="btn primary" type="submit" data-turbo-submits-with="Adding…">Add project</button></footer></form></div></turbo-frame>`;
  }

  function projectEditorModal(): string {
    return `<dialog id="project-editor-modal" class="project-editor-modal" data-controller="modal"><turbo-frame id="project_editor_frame" class="project-editor-frame"></turbo-frame></dialog>`;
  }

  function isGitHubRemoteUrl(gitUrl: string): boolean {
    return /(^|@|\/)github\.com[:/]/i.test(gitUrl.trim());
  }

  async function canReadRemoteWithConfiguredToken(gitUrl: string): Promise<boolean> {
    const token = discoverHostGitHubToken();
    interface GitProcessEnvironment {
      [name: string]: string | undefined;
    }
    const env: GitProcessEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (token) env.GH_TOKEN = token;
    const proc = Bun.spawn(["git", "-c", `credential.helper=${gitHubCredentialHelperCommand}`, "ls-remote", "--exit-code", gitUrl, "HEAD"], {
      stdout: "ignore",
      stderr: "pipe",
      env,
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

  // ---------------------------------------------------------------------------
  // Workspace detail residency host
  // ---------------------------------------------------------------------------

  async function attachWorkspaceModules(workspaceId: string): Promise<WorkspaceAttachment[]> {
    const entry = requireWorkspace(workspaceId);
    return await Promise.all(workspaceModules
      .filter((module) => module.attachToWorkspace)
      .map((module) => module.attachToWorkspace!({ workspaceId, init: entry.init, events: deps.events })));
  }

  const workViewAdapterByType = new Map(workViewAdapters.map((adapter) => [adapter.type, adapter]));

  function workViewKey(reference: WorkspaceWorkViewReference): string {
    const adapter = workViewAdapterByType.get(reference.type);
    if (!adapter) throw new AtelierCoreError("work_view_reference_invalid", `unknown Work view type: ${reference.type}`);
    return `${reference.type}:${adapter.identity(reference)}`;
  }

  function workViewClose(workspaceId: string, reference: WorkspaceWorkViewReference, label: string) {
    const encoded = encodeURIComponent(JSON.stringify(reference));
    return { action: `/workspaces/${encodeURIComponent(workspaceId)}/work-views/${encoded}/close`, label: `${label} Work view` };
  }

  function agentClose(workspaceId: string, conversationId: string, title: string) {
    return { action: `/workspaces/${encodeURIComponent(workspaceId)}/agent-conversations/${encodeURIComponent(conversationId)}/close`, label: `${title} Agent conversation` };
  }

  async function workspacePaneCollections(activeWorkspaceId: string): Promise<WorkspacePanePresentation> {
    const { projects: savedProjects } = await listProjects();
    const projectTitles = new Map(savedProjects.map((project) => [project.id, project.name]));
    const grouped = new Map<string, WorkspaceEntry[]>();
    const parkedByProject = new Map<string, WorkspaceEntry[]>();
    const projectless: WorkspaceEntry[] = [];
    const projectlessParked: WorkspaceEntry[] = [];
    for (const entry of registry.list()) {
      if (entry.phase === "deleting") continue;
      if (!isGitProjectInit(entry.init)) {
        (entry.parked ? projectlessParked : projectless).push(entry);
        continue;
      }
      const destination = entry.parked ? parkedByProject : grouped;
      destination.set(entry.init.projectId, [...(destination.get(entry.init.projectId) ?? []), entry]);
    }
    const paneEntry = (entry: WorkspaceEntry): WorkspacePaneEntry => {
      const pane: WorkspacePaneEntry = {
        id: entry.id,
        title: workspaceTitle(entry),
        active: entry.id === activeWorkspaceId,
        busy: entry.phase === "starting" || registry.isWorkspaceBusy(entry.id),
        outdated: entry.imageOutdated,
      };
      const unreadAt = registry.workspaceUnreadAt(entry.id);
      if (unreadAt !== undefined) pane.unreadAt = unreadAt;
      if (isGitProjectInit(entry.init)) pane.color = repoColor(entry.init.projectId);
      return pane;
    };
    const workspaceProjectIds = new Set([...grouped.keys(), ...parkedByProject.keys()]);
    return {
      projects: [...workspaceProjectIds].map((id) => {
        const entries = grouped.get(id) ?? [];
        const parkedEntries = parkedByProject.get(id) ?? [];
        const init = (entries[0] ?? parkedEntries[0])!.init;
        if (!isGitProjectInit(init)) throw new Error(`Project ${id} contains a projectless Workspace`);
        return { id, title: projectTitles.get(id) ?? init.name, workspaces: entries.map(paneEntry), parkedWorkspaces: parkedEntries.map(paneEntry) };
      }),
      emptyProjects: savedProjects.filter((project) => !workspaceProjectIds.has(project.id)).map((project) => ({ id: project.id, title: project.name })),
      projectlessWorkspaces: projectless.map(paneEntry),
      projectlessParkedWorkspaces: projectlessParked.map(paneEntry),
    };
  }

  function workViewPresentations(workspaceId: string, currentWorkViews: readonly WorkspaceWorkViewPresentation[], storedWorkViews: readonly WorkspaceWorkViewState[]): WorkPaneContribution[] {
    const currentByKey = new Map(currentWorkViews.map((view) => [workViewKey(view.reference), view]));
    return storedWorkViews.map((stored) => {
      const key = workViewKey(stored.reference);
      const contribution = currentByKey.get(key);
      const view: WorkPaneContribution = {
        key,
        label: contribution?.label ?? `${stored.reference.type} unavailable`,
        kind: contribution?.kind ?? "resource",
        mobileDestination: ["file", "browser", "terminal"].includes(stored.reference.type) ? "direct" : "more",
        availability: contribution?.availability ?? { phase: "unavailable", detail: "The referenced resource is not currently available." },
        bodyHtml: contribution?.bodyHtml ?? "",
        close: workViewClose(workspaceId, stored.reference, contribution?.label ?? stored.reference.type),
      };
      if (contribution?.sourceKey !== undefined) view.sourceKey = contribution.sourceKey;
      if (contribution?.actionsHtml !== undefined) view.actionsHtml = contribution.actionsHtml;
      if (stored.attentionSequence !== undefined) view.attentionSequence = stored.attentionSequence;
      return view;
    });
  }

  async function fixedWorkspacePresentation(workspaceId: string, options: { preserveLiveKeys?: ReadonlySet<string> } = {}): Promise<FixedWorkspacePresentation> {
    const entry = requireWorkspace(workspaceId);
    const attachments = await attachWorkspaceModules(workspaceId);
    const agentConversations = attachments.flatMap((attachment) => attachment.agentConversations ?? []);
    const currentWorkViews = attachments.flatMap((attachment) => attachment.workViews ?? []);
    await presentationStore.initialize(workspaceId, currentWorkViews.map((view) => view.reference));
    const storedWorkViews = await presentationStore.listWorkViews(workspaceId);
    const commands = attachments.flatMap((attachment) => attachment.commands ?? []).map((command) => ({
      id: command.id, label: command.label, description: command.description, scope: command.scope, placement: command.surfaces?.ui?.placement, binding: command.surfaces?.shortcut?.defaultBinding,
    }));
    return {
      workspace: { id: entry.id, title: workspaceTitle(entry) },
      agentConversations: agentConversations.map((conversation) => {
        const presented: AgentPaneContribution = { id: conversation.id, title: conversation.title, bodyHtml: conversation.bodyHtml ?? "" };
        if (agentConversations.length > 1) presented.close = agentClose(workspaceId, conversation.id, conversation.title);
        return presented;
      }),
      workViews: workViewPresentations(workspaceId, currentWorkViews, storedWorkViews),
      commands,
      overlayHtml: attachments.flatMap((attachment) => attachment.overlayHtml ?? []),
      preserveLiveKeys: options.preserveLiveKeys,
    };
  }

  async function workspaceDetailContent(id: string): Promise<string> {
    return renderWorkspacePresentation(await fixedWorkspacePresentation(id));
  }

  async function workspaceDetailResidentHtml(id: string, options: { visible?: boolean } = {}): Promise<string> {
    const entry = requireWorkspace(id);
    const projectAttr = isGitProjectInit(entry.init) ? ` data-project-id="${escapeHtml(entry.init.projectId)}"` : "";
    return `<div class="workspace-detail-resident ${options.visible ? "visible" : ""}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(id)}"${projectAttr}>${await workspaceDetailContent(id)}</div>`;
  }

  function workspaceBootResidentHtml(entry: WorkspaceEntry, options: { visible?: boolean } = {}): string {
    const deleteAction = entry.phase === "failed" ? `<form class="fixed-shell-delete-workspace" method="post" action="/workspaces/${encodeURIComponent(entry.id)}/delete"><button class="btn danger" type="submit" aria-label="Delete workspace">Delete workspace</button></form>` : "";
    const inner = `${provisioning.render(entry.id, { failed: entry.phase === "failed", error: entry.error })}${deleteAction}`;
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

  const emptyWorkspaceOnboardingId = "workspace_empty_onboarding";

  function emptyWorkspaceOnboardingHtml(pane: WorkspacePanePresentation): string {
    const state = workspacePaneOnboardingState(pane);
    const copy = state === "first-project"
      ? '<h1>Welcome to Atelier!</h1><p>Create your <strong data-empty-workspace-onboarding-target="origin">first project</strong> to get started!</p>'
      : state === "first-workspace"
        ? '<h1>Welcome to Atelier!</h1><p>Create your <strong data-empty-workspace-onboarding-target="origin">first workspace</strong> to get started!</p>'
        : '<h1>Welcome to Atelier</h1><p><strong data-empty-workspace-onboarding-target="origin">Select a workspace</strong> to get started.</p>';
    const welcome = `<section class="workspace-empty-welcome">${copy}</section>`;
    if (state === "workspaces") return `<div id="${emptyWorkspaceOnboardingId}">${welcome}</div>`;
    return `<div id="${emptyWorkspaceOnboardingId}" data-controller="empty-workspace-onboarding" data-empty-workspace-onboarding-destination-value="${state}">
      ${welcome}
      <svg class="workspace-empty-onboarding-arrow" aria-hidden="true" data-empty-workspace-onboarding-target="svg">
        <defs><marker id="workspace-empty-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"></path></marker></defs>
        <path data-empty-workspace-onboarding-target="path" marker-end="url(#workspace-empty-arrowhead)"></path>
      </svg>
    </div>`;
  }

  async function workspaceDetailHostHtml(pane: WorkspacePanePresentation, selectedId?: string): Promise<string> {
    const entry = selectedId ? registry.get(selectedId) : undefined;
    const resident = entry ? await workspaceResidentFor(entry, { visible: true }) : "";
    return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-residency" data-workspace-residency-max-resident-value="5">
      <div class="workspace-detail-empty" data-workspace-residency-target="empty"${resident ? " hidden" : ""}>${emptyWorkspaceOnboardingHtml(pane)}</div>
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

  async function renderProjectModals(): Promise<string> {
    const { projects } = await listProjects();
    return projects.map((project) => deleteProjectModal(project)).join("");
  }

  async function renderWorkspaceShell(selectedId?: string, options: { mainHtml?: string; showWhatsNew?: boolean } = {}): Promise<string> {
    const pane = await workspacePaneCollections(selectedId ?? "");
    return `<div class="app fixed-shell-app" data-controller="atelier-shortcuts workspace-navigation">
    ${renderWorkspacePane(pane, renderGlobalSidebarContributions())}
    <main class="fixed-shell-app-main">${options.mainHtml ?? await workspaceDetailHostHtml(pane, selectedId)}</main>
  </div>
  ${projectEditorModal()}
  <div id="update_modal_host"></div>
  <div id="settings_modal_host"></div>
  <div id="onboarding_modal_host">${await renderOnboardingDialogIfNeeded()}</div>
  <div id="${workspaceCommandModalHostId}"></div>
  <turbo-frame id="${agentLaunchModalFrameId}"></turbo-frame>
  <div id="project_modals">${await renderProjectModals()}</div>`;
  }

  async function homePage(): Promise<Response> {
    const selected = registry.list().find((entry) => !entry.parked);
    return response(layout("Workspaces", await renderWorkspaceShell(selected?.id), selected?.id));
  }

  function requireWorkspace(id: string): WorkspaceEntry {
    const entry = registry.get(id);
    if (!entry) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
    return entry;
  }

  async function workspaceJson(id: string): Promise<Response> {
    const entry = requireWorkspace(id);
    const workspace: Pick<WorkspaceEntry, "id" | "phase" | "parked" | "error"> & { title: string; url: string } = {
      id: entry.id,
      title: workspaceTitle(entry),
      phase: entry.phase,
      parked: entry.parked,
      url: `/workspaces/${encodeURIComponent(entry.id)}`,
    };
    if (entry.error) workspace.error = entry.error;
    if (entry.parked || (entry.phase !== "ready" && entry.phase !== "checking_delete")) return jsonResponse({ workspace });

    const presentation = await fixedWorkspacePresentation(id);
    const attachments = await attachWorkspaceModules(id);
    const handlers = new Map(workspaceModuleCommands().map((handler) => [handler.id, handler]));
    return jsonResponse({ workspace: {
      ...workspace,
      agentConversations: presentation.agentConversations.map(({ id, title }) => ({ id, title })),
      workViews: await presentationStore.listWorkViews(id),
      commands: attachments.flatMap((attachment) => attachment.commands ?? []).filter((command) => handlers.has(command.id)).map((command) => ({
        id: command.id,
        label: command.label,
        description: command.description,
        scope: command.scope,
        inputSchema: handlers.get(command.id)?.inputSchema ?? command.inputSchema ?? emptyWorkspaceCommandInputSchema,
      })),
    } });
  }

  function workspaceListEndpoint(request: Request, url: URL): Response {
    if (!requestAcceptsJson(request)) return Response.redirect(new URL("/", url).toString(), 302);
    return jsonResponse({ workspaces: registry.list().map((entry) => {
      const workspace: Pick<WorkspaceEntry, "id" | "phase" | "parked"> & { title: string; projectId?: string } = {
        id: entry.id,
        title: workspaceTitle(entry),
        phase: entry.phase,
        parked: entry.parked,
      };
      if (isGitProjectInit(entry.init)) workspace.projectId = entry.init.projectId;
      return workspace;
    }) });
  }

  async function workspacePage(id: string, request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) return await workspaceJson(id);
    const entry = requireWorkspace(id);
    if (entry.parked) return Response.redirect(new URL("/", request.url).toString(), 302);
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
    const initialPromptMode = agent?.initialPromptMode;
    const model = agent?.model ?? "";
    const thinkingLevel = agent?.thinkingLevel ?? "";
    const serviceTier = agent?.serviceTier ?? "";
    const attachmentDraft = agent?.attachmentDraft ?? "";
    if (!initialPrompt && !initialPromptMode && !model && !thinkingLevel && !serviceTier && !attachmentDraft) return undefined;
    const parameters: AgentWorkspaceParameters = { initialPrompt, model, thinkingLevel, serviceTier: serviceTier || undefined, attachmentDraft };
    if (initialPromptMode) parameters.initialPromptMode = initialPromptMode;
    return parameters;
  }

  function creationContext(source: WorkspaceCreateSource, agent: AgentWorkspaceParameters | undefined): WorkspaceCreationContext | undefined {
    const fork = forkForSource(source);
    const agentParameters = agentContext(agent);
    if (source.type !== "project" && !fork && !agentParameters) return undefined;
    const context: WorkspaceCreationContext = {};
    if (fork) context.fork = fork;
    if (agentParameters) context.agent = agentParameters;
    return context;
  }

  interface CreatedWorkspace {
    id: string;
  }

  function createWorkspaceFromCommand(command: { source: WorkspaceCreateSource; agent?: AgentWorkspaceParameters; title?: string }): CreatedWorkspace {
    const id = generateWorkspaceId();
    const init = initForSource(command.source);
    const title = command.title?.trim() ?? "";
    const context = creationContext(command.source, command.agent);
    const fork = forkForSource(command.source);
    registry.add(id, title || null, init);
    const options: Parameters<typeof startWorkspaceProvisioning>[1] = {};
    if (init !== undefined) options.init = init;
    if (context) options.context = context;
    if (title) options.title = title;
    if (fork) options.fork = fork;
    startWorkspaceProvisioning(id, options);
    return { id };
  }

  async function createWorkspaceEndpoint(url: URL, request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) {
      const body = await readWorkspaceCreateJson(request);
      const sourceType = stringField(body.source?.type, "source.type") ?? "empty";
      if (sourceType !== "empty" && sourceType !== "project") throw invalidArguments("source.type must be empty or project");
      const projectReference = stringField(body.source?.project, "source.project");
      let source: WorkspaceCreateSource = { type: "empty" };
      if (sourceType === "project") {
        if (!projectReference) throw invalidArguments("source.project is required for project workspaces");
        source = { type: "project", project: await projectByReference(projectReference) };
      }
      const agent = body.agent;
      const serviceTier = stringField(agent?.serviceTier, "agent.serviceTier");
      const { id } = createWorkspaceFromCommand({
        source,
        title: stringField(body.title, "title"),
        agent: {
          initialPrompt: stringField(agent?.initialPrompt, "agent.initialPrompt") ?? "",
          model: stringField(agent?.model, "agent.model") ?? "",
          thinkingLevel: stringField(agent?.thinkingLevel, "agent.thinkingLevel") ?? "",
          serviceTier: serviceTier ? (serviceTier === "priority" ? "priority" : "default") : undefined,
          attachmentDraft: stringField(agent?.attachmentDraft, "agent.attachmentDraft") ?? "",
        },
      });
      const location = new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString();
      return jsonResponse({ workspace: { id, phase: "starting", url: location } }, { status: 202, headers: { location } });
    }

    const { id } = createWorkspaceFromCommand({ source: { type: "empty" } });
    const location = new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString();
    if (wantsTurboStream(request)) return turboStreamResponse(workspacePaneCollectionsTurboStream(await workspacePaneCollections("")), { headers: { location } });
    return Response.redirect(location, 303);
  }

  async function createAgentWorkspaceFromForm(request: Request, options: { project?: ProjectSummary } = {}): Promise<Response> {
    const form = await request.formData();
    const attachmentDraft = String(form.get("attachmentDraft") ?? "");
    if (!attachmentDraft) throw invalidArguments("attachmentDraft is required");
    let launch = agentWorkspaceLaunches.get(attachmentDraft);
    if (!launch) {
      launch = (async () => {
        const model = String(form.get("model") ?? "");
        const thinkingLevel = String(form.get("level") ?? "");
        const serviceTier = form.get("serviceTier") === "priority" ? "priority" : "default";
        await rememberNewWorkspaceAgentSettings(model, thinkingLevel);
        return createWorkspaceFromCommand({
          source: options.project ? { type: "project", project: options.project } : { type: "empty" },
          agent: {
            initialPrompt: String(form.get("text") ?? ""),
            model,
            thinkingLevel,
            serviceTier,
            attachmentDraft,
          },
        });
      })();
      agentWorkspaceLaunches.set(attachmentDraft, launch);
    }
    const { id } = await launch;
    const selection = registry.list().length === 1 ? selectWorkspaceTurboStream(id) : "";

    return turboStreamResponse(`${workspacePaneCollectionsTurboStream(await workspacePaneCollections(""))}${turboUpdateStream(agentLaunchModalFrameId, "")}${selection}`);
  }

  async function createEmptyAgentWorkspaceEndpoint(request: Request): Promise<Response> {
    return await createAgentWorkspaceFromForm(request);
  }

  type WorkspaceCreateJsonBody = {
    source?: JsonObject;
    title?: JsonValue;
    agent?: JsonObject;
  };

  async function readWorkspaceCreateJson(request: Request): Promise<WorkspaceCreateJsonBody> {
    const record = await readJsonObject(request);
    const { source, title, agent } = record;
    if (source !== undefined && !isJsonObject(source)) throw invalidArguments("source must be an object");
    if (agent !== undefined && !isJsonObject(agent)) throw invalidArguments("agent must be an object");
    return { source, title, agent };
  }

  function stringField(value: JsonValue | undefined, name: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${name} must be a string`);
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

  async function deleteWorkspaceEndpoint(id: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (!canDeleteWorkspace(entry)) {
      if (requestAcceptsJson(request)) return jsonResponse({ error: { code: "workspace_not_ready", message: `workspace ${id} is not ready for deletion` } }, { status: 409 });
      return turboStreamResponse(turboRemoveStream("delete-workspace-modal"), { status: 409 });
    }
    const force = requestAcceptsJson(request)
      ? (await readJsonObject(request)).force === true
      : new URL(request.url).searchParams.get("force") === "1";
    const result = await inspectAndScheduleWorkspaceDeletion(id, force);
    if (requestAcceptsJson(request)) return jsonResponse(result);
    if (result.blocked) return turboStreamResponse(`${turboRemoveStream("delete-workspace-modal")}${turboStream("append", "body", deleteBlockedModal(id, result.details!))}`);
    return turboStreamResponse(turboRemoveStream("delete-workspace-modal"));
  }

  async function parkWorkspaceEndpoint(id: string, parked: boolean, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.phase !== "ready") return requestAcceptsJson(request)
      ? jsonResponse({ error: { code: "workspace_not_ready", message: `workspace ${id} is not ready` } }, { status: 409 })
      : wantsTurboStream(request) ? turboStreamResponse("", { status: 409 }) : response("Workspace is not ready", { status: 409 });
    if (entry.parked !== parked) {
      await persistWorkspaceParked(id, parked);
      suppressParkedStateCallbacks = true;
      registry.setParked(id, parked);
      suppressParkedStateCallbacks = false;
    }
    const parkedResident = parked ? removeWorkspaceResidentTurboStream(id) : "";
    const stateStream = `${workspacePaneCollectionsTurboStream(await workspacePaneCollections(""))}${parkedResident}`;
    broadcastShell(stateStream);
    if (requestAcceptsJson(request)) return jsonResponse({ workspace: { id, parked } });
    if (wantsTurboStream(request)) return turboStreamResponse(stateStream);
    return Response.redirect(request.headers.get("referer") ?? "/", 303);
  }

  // ---------------------------------------------------------------------------
  // Titles
  // ---------------------------------------------------------------------------

  async function updateWorkspaceSidebarTitle(id: string, request: Request): Promise<Response> {
    requireWorkspace(id);
    const title = requestAcceptsJson(request)
      ? stringField((await readJsonObject(request)).title, "title") ?? ""
      : String((await request.formData()).get("title") ?? "").trim();
    await setWorkspaceTitle(id, title);
    registry.setTitle(id, title || null);
    return requestAcceptsJson(request) ? await workspaceJson(id) : turboStreamResponse(workspacePaneCollectionsTurboStream(await workspacePaneCollections(id)));
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  async function renderProjectModalStreams(options: { clearCommandModal?: boolean } = {}): Promise<string> {
    return `${turboUpdateStream("project_modals", await renderProjectModals())}${options.clearCommandModal ? turboUpdateStream(workspaceCommandModalHostId, "") : ""}`;
  }

  function jsonString(body: JsonObject, field: string): string {
    const value = body[field];
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${field} is required`);
    return value;
  }

  function requiredJsonString(body: JsonObject, field: string): string {
    const value = jsonString(body, field);
    if (!value.trim()) throw invalidArguments(`${field} is required`);
    return value;
  }

  function optionalJsonString(body: JsonObject, field: string): string | undefined {
    const value = body[field];
    if (value === undefined) return undefined;
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${field} must be a string`);
    return value;
  }

  async function projectDetailEndpoint(projectId: string): Promise<Response> {
    const project = await projectById(projectId);
    const [environment, secrets] = await Promise.all([
      listProjectEnvironmentVariables(projectId),
      listProjectSecrets(projectId),
    ]);
    return jsonResponse({ project: { ...project, environment, secrets } });
  }

  async function createProjectEndpoint(request: Request, url: URL): Promise<Response> {
    const json = requestAcceptsJson(request);
    const gitUrl = json
      ? requiredJsonString(await readJsonObject(request), "gitUrl")
      : String((await request.formData()).get("gitUrl") ?? "");
    let project: ProjectSummary;
    try {
      project = (await addProject(gitUrl)).project;
    } catch (error) {
      if (!(error instanceof AtelierCoreError && error.code === "project_exists")) throw error;
      const specification = parseProjectSpec(gitUrl);
      const projects = (await listProjects()).projects;
      project = projects.find((candidate) => candidate.gitUrl === specification.gitUrl && candidate.branch === specification.branch)!;
    }
    const paneStream = await refreshWorkspacePaneCollections();
    if (json) return jsonResponse({ project });
    if (wantsTurboStream(request)) return turboStreamResponse(`${await renderProjectModalStreams()}${turboUpdateStream("project_editor_frame", "")}${paneStream}`);
    return Response.redirect(new URL("/", url).toString(), 303);
  }

  async function updateProjectEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    let name: string;
    let spec: string;
    if (json) {
      const body = await readJsonObject(request);
      name = requiredJsonString(body, "name");
      spec = requiredJsonString(body, "gitUrl");
    } else {
      const formData = await request.formData();
      name = String(formData.get("name") ?? "");
      spec = String(formData.get("gitUrl") ?? "");
    }
    const { project } = await updateProject(projectId, { name, spec });
    const paneStream = await refreshWorkspacePaneCollections();
    return json ? jsonResponse({ project }) : turboStreamResponse(`${await renderProjectModalStreams()}${paneStream}`);
  }

  async function renderProjectEnvironmentStreams(projectId: string): Promise<string> {
    const project = await projectById(projectId);
    return turboReplaceStream(domId("project_environment", projectId), projectEnvironmentEditor(project, await listProjectEnvironmentVariables(projectId)));
  }

  async function projectEnvironmentVariableValues(request: Request): Promise<{ name: string; value: string }> {
    if (!requestAcceptsJson(request)) {
      const formData = await request.formData();
      return { name: String(formData.get("name") ?? ""), value: String(formData.get("value") ?? "") };
    }
    const body = await readJsonObject(request);
    return { name: requiredJsonString(body, "name"), value: jsonString(body, "value") };
  }

  async function createProjectEnvironmentVariableEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const environmentVariable = await createProjectEnvironmentVariable(projectId, await projectEnvironmentVariableValues(request));
    return json ? jsonResponse({ environmentVariable }) : turboStreamResponse(await renderProjectEnvironmentStreams(projectId));
  }

  async function updateProjectEnvironmentVariableEndpoint(projectId: string, variableId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const environmentVariable = await updateProjectEnvironmentVariable(projectId, variableId, await projectEnvironmentVariableValues(request));
    return json ? jsonResponse({ environmentVariable }) : turboStreamResponse(await renderProjectEnvironmentStreams(projectId));
  }

  async function deleteProjectEnvironmentVariableEndpoint(projectId: string, variableId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    if (json) await readJsonObject(request);
    const environmentVariable = await deleteProjectEnvironmentVariable(projectId, variableId);
    return json ? jsonResponse({ deleted: true, environmentVariable }) : turboStreamResponse(await renderProjectEnvironmentStreams(projectId));
  }

  async function renderProjectSecretStreams(projectId: string): Promise<string> {
    const project = await projectById(projectId);
    return turboReplaceStream(domId("project_secrets", projectId), projectSecretEditor(project, await listProjectSecrets(projectId)));
  }

  type ProjectSecretValues = { envName: string; hostPattern: string; placeholder?: string; secretValue?: string };

  async function projectSecretValues(request: Request, secretValueRequired: boolean): Promise<ProjectSecretValues> {
    if (!requestAcceptsJson(request)) {
      const formData = await request.formData();
      return {
        envName: String(formData.get("envName") ?? ""),
        hostPattern: String(formData.get("hostPattern") ?? ""),
        placeholder: String(formData.get("placeholder") ?? ""),
        secretValue: String(formData.get("secretValue") ?? "") || undefined,
      };
    }
    const body = await readJsonObject(request);
    return {
      envName: requiredJsonString(body, "envName"),
      hostPattern: requiredJsonString(body, "hostPattern"),
      placeholder: optionalJsonString(body, "placeholder"),
      secretValue: secretValueRequired ? requiredJsonString(body, "secretValue") : optionalJsonString(body, "secretValue"),
    };
  }

  async function createProjectSecretEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const values = await projectSecretValues(request, true);
    const secret = await createProjectSecret(projectId, { ...values, secretValue: values.secretValue! });
    return json ? jsonResponse({ secret }) : turboStreamResponse(await renderProjectSecretStreams(projectId));
  }

  async function updateProjectSecretEndpoint(projectId: string, secretId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const secret = await updateProjectSecret(projectId, secretId, await projectSecretValues(request, false));
    return json ? jsonResponse({ secret }) : turboStreamResponse(await renderProjectSecretStreams(projectId));
  }

  async function deleteProjectSecretEndpoint(projectId: string, secretId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    if (json) await readJsonObject(request);
    const secret = await deleteProjectSecret(projectId, secretId);
    return json ? jsonResponse({ deleted: true, secret }) : turboStreamResponse(await renderProjectSecretStreams(projectId));
  }

  async function renderProjectSshKeyStreams(projectId: string): Promise<string> {
    const project = await projectById(projectId);
    return turboReplaceStream(domId("project_ssh_key", projectId), projectSshKeyEditor(project, await hasProjectSshKey(projectId)));
  }

  async function saveProjectSshKeyFromForm(projectId: string, request: Request): Promise<Response> {
    await projectById(projectId);
    const formData = await request.formData();
    const privateKey = String(formData.get("privateKey") ?? "");
    if (privateKey) await setProjectSshKey(projectId, privateKey);
    return turboStreamResponse(await renderProjectSshKeyStreams(projectId));
  }

  async function deleteProjectSshKeyFromForm(projectId: string): Promise<Response> {
    await projectById(projectId);
    await deleteProjectSshKey(projectId);
    return turboStreamResponse(await renderProjectSshKeyStreams(projectId));
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

  async function deleteProjectEndpoint(projectId: string, request: Request): Promise<Response> {
    const json = requestAcceptsJson(request);
    const project = await projectById(projectId);
    if (json) await readJsonObject(request);
    const references = projectReferencingWorkspaces(projectId);
    if (references.length > 0) {
      if (json) return jsonResponse({
        deleted: false,
        blocked: true,
        references: references.map((entry) => ({ workspaceId: entry.id, title: workspaceTitle(entry) })),
      });
      return turboStreamResponse(`${turboUpdateStream("project_modals", await renderProjectModals())}${turboUpdateStream(workspaceCommandModalHostId, deleteProjectBlockedModal(project, references))}`);
    }
    await deleteProject(projectId);
    const paneStream = await refreshWorkspacePaneCollections();
    if (json) return jsonResponse({ deleted: true, blocked: false, project });
    return turboStreamResponse(`${await renderProjectModalStreams({ clearCommandModal: true })}${turboUpdateStream("project_editor_frame", "")}${paneStream}`);
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


  function workspaceModuleCommands(): WorkspaceModuleCommandHandler[] {
    return workspaceModules.flatMap((module) => module.commands ?? []);
  }

  function workspaceModuleRoutes(): WorkspaceModuleRouteHandler[] {
    return workspaceModules.flatMap((module) => module.routes ?? []);
  }

  async function commandInput<Input>(request: Request, command: WorkspaceModuleCommandHandler<Input>): Promise<Input> {
    let input = {};
    if (requestAcceptsJson(request)) {
      const text = await request.text();
      if (text.trim()) {
        try { input = JSON.parse(text); } catch { throw invalidArguments("valid JSON command input is required"); }
      }
    }
    if (!isJsonObject(input)) throw invalidArguments("JSON command input must be an object");
    const schema = command.inputSchema ?? emptyWorkspaceCommandInputSchema;
    // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
    if (!Value.Check(schema as never, input)) {
      // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
      const issue = [...Value.Errors(schema as never, input)][0];
      throw invalidArguments(`invalid ${command.id} input: ${issue?.message ?? "schema check failed"}`);
    }
    // SAFETY: the command-owned schema validated input against the handler's Input contract.
    return input as Input;
  }

  async function executeWorkspaceCommand(workspaceId: string, commandId: string, request: Request): Promise<WorkspaceModuleCommandResult> {
    const commands = workspaceModuleCommands();
    const command = commands.find((candidate) => candidate.id === commandId);
    if (!command) throw new AtelierCoreError("command_not_found", `workspace command not found: ${commandId}`, { availableCommands: commands.map((candidate) => candidate.id) });
    return await command.execute({ workspaceId, events: deps.events, input: await commandInput(request, command) });
  }

  async function openWorkspaceModuleWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<Response> {
    const attachments = await attachWorkspaceModules(workspaceId);
    const currentWorkViews = attachments.flatMap((attachment) => attachment.workViews ?? []);
    const contribution = currentWorkViews.find((view) => workViewKey(view.reference) === workViewKey(reference));
    if (!contribution) throw new AtelierCoreError("work_view_not_found", `Work view is not available: ${workViewKey(reference)}`);
    const { opened } = await presentationStore.openWorkView(workspaceId, contribution.reference);
    const key = workViewKey(contribution.reference);
    const insertion = opened
      ? openWorkViewTurboStream(workspaceId, workViewPresentations(workspaceId, currentWorkViews, await presentationStore.listWorkViews(workspaceId)), key)
      : "";
    return turboStreamResponse(`${insertion}${presentWorkViewTurboStream(workspaceId, key)}`);
  }

  async function workspaceCommandEndpoint(workspaceId: string, commandId: string, request: Request): Promise<Response> {
    const before = await fixedWorkspacePresentation(workspaceId);
    const result = await executeWorkspaceCommand(workspaceId, commandId, request);
    let createdWorkView: WorkspaceWorkViewReference | undefined;
    if (result.createdWorkView) {
      const metadata = await attachWorkspaceModules(workspaceId);
      const contribution = metadata.flatMap((attachment) => attachment.workViews ?? []).find((view) => workViewKey(view.reference) === workViewKey(result.createdWorkView!));
      if (!contribution) throw new AtelierCoreError("work_view_not_found", `Command ${commandId} created an unavailable Work view`);
      createdWorkView = contribution.reference;
      await presentationStore.openWorkView(workspaceId, createdWorkView);
    }
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) {
      const command: WorkspaceCommandResponse = { id: commandId };
      if (createdWorkView) command.workView = createdWorkView;
      if (result.createdAgentConversationId) command.agentConversationId = result.createdAgentConversationId;
      return jsonResponse({ command, workViews: await presentationStore.listWorkViews(workspaceId) });
    }
    if (!createdWorkView && !result.createdAgentConversationId) return turboStreamResponse(result.streamHtml ?? "");
    const preserveLiveKeys = new Set([...before.agentConversations.map((agent) => `agent:${agent.id}`), ...before.workViews.map((view) => `work:${view.key}`)]);
    const presentation = await fixedWorkspacePresentation(workspaceId, { preserveLiveKeys });
    const reveal = createdWorkView ? presentWorkViewTurboStream(workspaceId, workViewKey(createdWorkView)) : "";
    return turboStreamResponse(`${workspacePresentationTurboStream(workspaceId, presentation)}${reveal}${result.streamHtml ?? ""}`);
  }

  async function closeWorkViewEndpoint(workspaceId: string, encodedReference: string, request: Request): Promise<Response> {
    // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
    const reference = JSON.parse(encodedReference) as WorkspaceWorkViewReference;
    const before = await fixedWorkspacePresentation(workspaceId);
    const adapter = workViewAdapterByType.get(reference.type);
    if (!adapter) throw new AtelierCoreError("work_view_reference_invalid", `unknown Work view type: ${reference.type}`);
    const parsed = adapter.parseReference(reference);
    const open = (await presentationStore.listWorkViews(workspaceId)).some((view) => workViewKey(view.reference) === workViewKey(parsed));
    if (!open) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${workViewKey(parsed)}`);
    await adapter.close?.({ workspaceId, reference: parsed });
    await presentationStore.closeWorkView(workspaceId, parsed);
    const preserveLiveKeys = new Set([
      ...before.agentConversations.map((agent) => `agent:${agent.id}`),
      ...before.workViews.filter((view) => view.key !== workViewKey(parsed)).map((view) => `work:${view.key}`),
    ]);
    if (requestAcceptsJson(request)) return jsonResponse({ closed: parsed, workViews: await presentationStore.listWorkViews(workspaceId) });
    return turboStreamResponse(workspacePresentationTurboStream(workspaceId, await fixedWorkspacePresentation(workspaceId, { preserveLiveKeys })));
  }

  async function reorderWorkViewEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseReorderWorkViewRequest(await readJsonObject(request));
    const before = await fixedWorkspacePresentation(workspaceId);
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === body.key);
    if (!stored) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${body.key}`);
    await presentationStore.reorderWorkView(workspaceId, stored.reference, body.index);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) return jsonResponse({ workViews: await presentationStore.listWorkViews(workspaceId) });
    const preserveLiveKeys = new Set([...before.agentConversations.map((agent) => `agent:${agent.id}`), ...before.workViews.map((view) => `work:${view.key}`)]);
    return turboStreamResponse(workspacePresentationTurboStream(workspaceId, await fixedWorkspacePresentation(workspaceId, { preserveLiveKeys })));
  }

  async function closeWorkViewJsonEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseCloseWorkViewRequest(await readJsonObject(request));
    return await closeWorkViewEndpoint(workspaceId, JSON.stringify(body.reference), request);
  }

  async function presentWorkViewFromAgent(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    const before = await fixedWorkspacePresentation(workspaceId);
    const attachments = await attachWorkspaceModules(workspaceId);
    const contribution = attachments.flatMap((attachment) => attachment.workViews ?? []).find((view) => workViewKey(view.reference) === workViewKey(reference));
    if (!contribution) throw new AtelierCoreError("work_view_not_found", `Work view is not available: ${workViewKey(reference)}`);
    await presentationStore.openWorkView(workspaceId, contribution.reference);
    registry.setParked(workspaceId, false);
    await presentationStore.requestAttention(workspaceId, contribution.reference);
    const preserveLiveKeys = new Set([...before.agentConversations.map((agent) => `agent:${agent.id}`), ...before.workViews.map((view) => `work:${view.key}`)]);
    const key = workViewKey(contribution.reference);
    const presentation = await fixedWorkspacePresentation(workspaceId, { preserveLiveKeys });
    broadcastShell(`${workspacePresentationTurboStream(workspaceId, presentation)}${presentWorkViewTurboStream(workspaceId, key)}`);
  }

  async function workViewAttentionEndpoint(workspaceId: string, key: string, request: Request, acknowledge: boolean): Promise<Response> {
    const before = await fixedWorkspacePresentation(workspaceId);
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === key);
    if (!stored) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${key}`);
    if (acknowledge) await presentationStore.acknowledgeAttention(workspaceId, stored.reference);
    else {
      registry.setParked(workspaceId, false);
      await presentationStore.requestAttention(workspaceId, stored.reference);
    }
    const preserveLiveKeys = new Set([
      ...before.agentConversations.map((agent) => `agent:${agent.id}`),
      ...before.workViews.map((view) => `work:${view.key}`),
    ]);
    const presentationStream = workspacePresentationTurboStream(workspaceId, await fixedWorkspacePresentation(workspaceId, { preserveLiveKeys }));
    if (acknowledge) {
      broadcastShell(presentationStream);
      return requestAcceptsJson(request) ? jsonResponse({ acknowledged: stored.reference }) : new Response(null, { status: 204 });
    }
    const revealStream = presentWorkViewTurboStream(workspaceId, key);
    return requestAcceptsJson(request) ? jsonResponse({ attention: stored.reference }) : turboStreamResponse(`${presentationStream}${revealStream}`);
  }

  async function closeAgentConversationEndpoint(workspaceId: string, conversationId: string, request: Request): Promise<Response> {
    const before = await fixedWorkspacePresentation(workspaceId);
    await presentationStore.closeAgentConversation(workspaceId, conversationId);
    const preserveLiveKeys = new Set([
      ...before.agentConversations.filter((agent) => agent.id !== conversationId).map((agent) => `agent:${agent.id}`),
      ...before.workViews.map((view) => `work:${view.key}`),
    ]);
    if (requestAcceptsJson(request)) return jsonResponse({ archivedConversationId: conversationId, agentConversations: await presentationStore.listAgentConversations(workspaceId) });
    return turboStreamResponse(workspacePresentationTurboStream(workspaceId, await fixedWorkspacePresentation(workspaceId, { preserveLiveKeys })));
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

  // ---------------------------------------------------------------------------
  // Errors + routing
  // ---------------------------------------------------------------------------

  function errorPage(error: Error): Response {
    const status = error instanceof AtelierCoreError && ["workspace_not_found", "project_not_found", "repo_not_found", "terminal_not_found", "agent_conversation_not_found"].includes(error.code) ? 404 : 500;
    const message = error.message;
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
    if (url.pathname === "/openapi.json" && request.method === "GET") return jsonResponse(atelierOpenApi(workspaceModuleCommands()));
    if (url.pathname === "/agent-launch" && request.method === "GET") return response(await launchEmptyAgentFrame());
    if (url.pathname === "/agent-launch/settings" && request.method === "GET") return response(await agentLaunchSettingsFrame(url.searchParams.get("model") ?? undefined));
    if (url.pathname === "/workspaces" && request.method === "GET") return workspaceListEndpoint(request, url);
    if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceEndpoint(url, request);
    if (url.pathname === "/workspaces/open-oldest-unread" && request.method === "POST") return openOldestUnreadWorkspaceEndpoint();
    if (url.pathname === "/workspaces/active/clear" && request.method === "POST") return clearActiveWorkspaceEndpoint();
    if (url.pathname === "/projects" && request.method === "GET" && requestAcceptsJson(request)) return jsonResponse(await listProjects());
    if (url.pathname === "/projects" && request.method === "POST") return await createProjectEndpoint(request, url);
    if (url.pathname === "/projects/new/editor" && request.method === "GET") return response(newProjectEditorFrame());
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
      const moduleResponse = await moduleRoute.handle(request, url, { events: deps.events, openWorkView: openWorkspaceModuleWorkView });
      if (moduleResponse) return moduleResponse;
    }

    let params: string[] | undefined;

    if ((params = match(/^\/projects\/([^/]+)\/editor$/)) && request.method === "GET") return response(await projectEditorFrame(await projectById(params[0])));
    if ((params = match(/^\/projects\/([^/]+)\/agent-launch$/)) && request.method === "GET") return response(await launchProjectAgentFrame(await projectById(params[0])));
    if ((params = match(/^\/projects\/([^/]+)$/)) && request.method === "GET" && requestAcceptsJson(request)) return await projectDetailEndpoint(params[0]);
    if ((params = match(/^\/projects\/([^/]+)$/)) && request.method === "POST") return await updateProjectEndpoint(params[0], request);
    if ((params = match(/^\/projects\/([^/]+)\/environment$/)) && request.method === "POST") return await createProjectEnvironmentVariableEndpoint(params[0], request);
    if ((params = match(/^\/projects\/([^/]+)\/environment\/([^/]+)$/)) && request.method === "POST") return await updateProjectEnvironmentVariableEndpoint(params[0], params[1], request);
    if ((params = match(/^\/projects\/([^/]+)\/environment\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectEnvironmentVariableEndpoint(params[0], params[1], request);
    if ((params = match(/^\/projects\/([^/]+)\/secrets$/)) && request.method === "POST") return await createProjectSecretEndpoint(params[0], request);
    if ((params = match(/^\/projects\/([^/]+)\/secrets\/([^/]+)$/)) && request.method === "POST") return await updateProjectSecretEndpoint(params[0], params[1], request);
    if ((params = match(/^\/projects\/([^/]+)\/secrets\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectSecretEndpoint(params[0], params[1], request);
    if ((params = match(/^\/projects\/([^/]+)\/ssh-key$/)) && request.method === "POST") return await saveProjectSshKeyFromForm(params[0], request);
    if ((params = match(/^\/projects\/([^/]+)\/ssh-key\/delete$/)) && request.method === "POST") return await deleteProjectSshKeyFromForm(params[0]);
    if ((params = match(/^\/projects\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteProjectEndpoint(params[0], request);

    if (url.pathname === "/agent-workspaces" && request.method === "POST") return await createEmptyAgentWorkspaceEndpoint(request);
    if ((params = match(/^\/project-agent-workspaces\/([^/]+)$/)) && request.method === "POST") return await createProjectAgentWorkspaceEndpoint(params[0], request);

    if ((params = match(/^\/workspaces\/([^/]+)\/sidebar-title$/)) && request.method === "POST") return await updateWorkspaceSidebarTitle(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/active$/)) && request.method === "POST") return activeWorkspaceEndpoint(params[0]);
    if ((params = match(/^\/workspaces\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") return await workspaceCommandEndpoint(params[0], params[1], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/close$/)) && request.method === "POST") return await closeWorkViewJsonEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/(.+)\/attention\/request$/)) && request.method === "POST") return await workViewAttentionEndpoint(params[0], params[1], request, false);
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/(.+)\/attention\/acknowledge$/)) && request.method === "POST") return await workViewAttentionEndpoint(params[0], params[1], request, true);
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/(.+)\/close$/)) && request.method === "POST") return await closeWorkViewEndpoint(params[0], params[1], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/reorder$/)) && request.method === "POST") return await reorderWorkViewEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/agent-conversations\/([^/]+)\/close$/)) && request.method === "POST") return await closeAgentConversationEndpoint(params[0], params[1], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/park$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], true, request);
    if ((params = match(/^\/workspaces\/([^/]+)\/unpark$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], false, request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteWorkspaceEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)$/)) && request.method === "GET") return await workspacePage(params[0], request);

    return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return {
    shellSnapshot: async () => workspacePaneCollectionsTurboStream(await workspacePaneCollections("")),
    deleteCurrentWorkspaceFromAgent,
    createWorkspaceFromAgent,
    forkCurrentWorkspaceFromAgent,
    presentWorkViewFromAgent,
    globalSidebarContributions,
    async fetch(request) {
      try {
        return await route(request);
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        return requestAcceptsJson(request) ? problemJsonResponse(error) : errorPage(error);
      }
    },
  };
}
