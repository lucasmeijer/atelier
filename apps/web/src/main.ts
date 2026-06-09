import type { ServerWebSocket } from "bun";
import {
  closeAgentSocket,
  createAgentEndpoint,
  ensureDefaultWorkspaceAgent,
  handleAgentSocketMessage,
  listOrCreateWorkspaceAgents,
  openAgentSocket,
  renderWorkspaceAgentTabs,
  validateAgentSocket,
  type AgentSocketData,
} from "@atelier/agent/server";
import {
  AtelierCoreError,
  addManagedRepo,
  cloneManagedRepoIntoWorkspace,
  createAtelierEventBus,
  createWorkspace,
  deleteWorkspace,
  getWorkspaceRepoMergeability,
  listManagedRepos,
  listWorkspaces,
  listWorkspaceRepos,
  pushWorkspaceRepo,
  setWorkspaceTitle,
  type WorkspaceRepoMergeabilityResult,
} from "@atelier/core";
import {
  closeTerminalSocket,
  createTerminalEndpoint,
  deleteTerminalEndpoint,
  handleTerminalSocketMessage,
  listTerminalsEndpoint,
  listWorkspaceTerminals,
  openTerminalSocket,
  registerTerminalEvents,
  renderWorkspaceTerminalTabs,
  terminalStaticFiles,
  validateTerminalSocket,
  type TerminalSocketData,
} from "@atelier/terminal/server";
import { atelierName } from "@atelier/shared";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const pendingWorkspaceCreations = new Map<string, Promise<{ id: string }>>();
const atelierEvents = createAtelierEventBus();
registerTerminalEvents(atelierEvents);

async function createWorkspaceWithDefaultAgent(): Promise<{ id: string }> {
  const created = await createWorkspace();
  await Promise.all([
    ensureDefaultWorkspaceAgent(created.id),
    atelierEvents.emit("workspace_created", { workspaceId: created.id }),
  ]);
  return created;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

type HtmlResponseInit = Omit<ResponseInit, "headers"> & { headers?: Record<string, string> };

function response(body: string, init: HtmlResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(atelierName)} · ${escapeHtml(title)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/terminal.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/@hotwired/turbo@8.0.13/dist/turbo.es2017-esm.js"></script>
<script type="module">
  import { Application, Controller } from "https://cdn.jsdelivr.net/npm/@hotwired/stimulus@3.2.2/+esm";
  window.Stimulus = { Application, Controller };
</script>
<script type="module" src="/workspace.js"></script>
</head>
<body id="body">${body}
</body>
</html>`;
}

async function serveStatic(pathname: string): Promise<Response | undefined> {
  const staticFiles: Record<string, { url: URL; contentType: string }> = {
    "/style.css": { url: new URL("../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/workspace.js": { url: new URL("../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
    ...terminalStaticFiles,
  };
  const entry = staticFiles[pathname];
  if (!entry) return undefined;
  const file = Bun.file(entry.url);
  if (!(await file.exists())) return response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(file, { headers: { "content-type": entry.contentType } });
}

function workspaceRow(id: string, title: string, state: "ready" | "initializing" = "ready"): string {
  const initializing = state === "initializing";
  return `<div class="row workspace-row ${initializing ? "initializing" : ""}" id="${domId("workspace_row", id)}">
      <span class="dot ${initializing ? "wait" : "run"}"></span>
      ${initializing ? `<div class="row-main"><div class="r-title">${escapeHtml(title)}</div><div class="r-sub">Initializing workspace…</div></div>` : `<a class="row-main" href="/workspaces/${encodeURIComponent(id)}" data-turbo-frame="_top"><div class="r-title">${escapeHtml(title)}</div><div class="r-sub">${escapeHtml(id)}</div></a>`}
      <span class="row-actions">${initializing ? `<span class="status-spinner" aria-label="Initializing"></span>` : deleteWorkspaceForm(id)}</span>
    </div>`;
}

function deleteWorkspaceForm(id: string, returnTo?: string): string {
  return `<form class="contents" method="post" action="/workspaces/${encodeURIComponent(id)}/delete">
    ${returnTo ? `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">` : ""}
    <button class="btn danger sm" type="submit">Delete</button>
  </form>`;
}

function deleteBlockedModal(id: string, details: unknown, returnTo = ""): string {
  const issues = (details && typeof details === "object" && "issues" in details && Array.isArray((details as { issues?: unknown }).issues)) ? (details as { issues: Array<{ repo?: unknown; uncommittedPaths?: unknown; outgoingCommits?: unknown }> }).issues : [];
  const issueHtml = issues.map((issue) => {
    const paths = Array.isArray(issue.uncommittedPaths) ? issue.uncommittedPaths : [];
    const commits = Array.isArray(issue.outgoingCommits) ? issue.outgoingCommits as Array<{ hash?: unknown; subject?: unknown }> : [];
    return `<section class="delete-issue"><h3>${escapeHtml(issue.repo ?? "unknown repo")}</h3>
      ${paths.length > 0 ? `<h4>Uncommitted/staged paths</h4><ul>${paths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}</ul>` : ""}
      ${commits.length > 0 ? `<h4>Unpushed commits</h4><ul>${commits.map((commit) => `<li><code>${escapeHtml(String(commit.hash ?? "").slice(0, 12))}</code> ${escapeHtml(commit.subject ?? "")}</li>`).join("")}</ul>` : ""}
    </section>`;
  }).join("");
  return `<dialog id="delete-workspace-modal" class="modal delete-modal" data-controller="modal" data-modal-auto-show-value="true">
    <form method="dialog"><h2>Workspace has uncommitted changes</h2><p>Deleting this workspace would discard local changes or commits that have not been pushed.</p>${issueHtml}<div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn danger" value="force" form="force-delete-workspace-form">Force delete</button></div></form>
    <form id="force-delete-workspace-form" method="post" action="/workspaces/${encodeURIComponent(id)}/delete?force=1">${returnTo ? `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">` : ""}</form>
  </dialog>`;
}

function addManagedRepoModal(): string {
  return `<dialog id="add-managed-repo-modal" class="modal" data-controller="modal">
  <form method="post" action="/managed-repos">
    <h2>Add managed repository</h2>
    <p>Create a bare clone in Atelier's data directory.</p>
    <input class="modal-input" name="gitUrl" type="url" placeholder="https://github.com/org/repo.git" required autofocus>
    <div class="modal-actions">
      <button class="btn" type="button" data-action="modal#close">Cancel</button>
      <button class="btn primary" type="submit">Add repository</button>
    </div>
  </form>
</dialog>`;
}

function cloneManagedRepoModal(id: string, managedRepos: Array<{ name: string; remoteUrl: string | null }>, workspaceRepos: string[]): string {
  const workspaceRepoNames = new Set(workspaceRepos);
  const repoButtons = managedRepos.map((repo) => {
    const worktreeName = repo.name.endsWith(".git") ? repo.name.slice(0, -4) : repo.name;
    const alreadyInWorkspace = workspaceRepoNames.has(worktreeName) || workspaceRepoNames.has(repo.name);
    if (alreadyInWorkspace) {
      return `<div class="row clone-managed-repo-row disabled">
        <span></span>
        <div><div class="r-title">${escapeHtml(worktreeName)}</div><div class="r-sub">Already in workspace</div></div>
        <span></span>
      </div>`;
    }
    return `<form method="post" action="/workspaces/${encodeURIComponent(id)}/clone-managed-repo" class="contents">
      <input type="hidden" name="repo" value="${escapeHtml(repo.name)}">
      <button class="row ghost-row clone-managed-repo-row" type="submit">
        <span class="clone-plus">+</span>
        <div><div class="r-title">${escapeHtml(worktreeName)}</div></div>
        <span></span>
      </button>
    </form>`;
  }).join("");

  return `<dialog id="clone-managed-repo-modal" class="modal" data-controller="modal">
    <div class="modal-content">
      <p>Select a managed repository to clone into this workspace.</p>
      <div class="repo-list compact clone-repo-list">
        ${repoButtons || `<div class="row"><span></span><div><div class="r-title">No managed repositories</div><div class="r-sub">Add one from the Workspaces page first.</div></div><span></span></div>`}
      </div>
      <div class="modal-actions"><button class="btn" type="button" data-action="modal#close">Cancel</button></div>
    </div>
  </dialog>`;
}

async function workspacesPage(): Promise<Response> {
  const [{ workspaces }, { repos: managedRepos }] = await Promise.all([listWorkspaces(), listManagedRepos()]);
  const rows = workspaces.map((workspace) => workspaceRow(workspace.id, workspace.title || `Workspace ${workspace.id}`)).join("");

  const newWorkspaceRow = `<form class="contents" method="post" action="/workspaces"><button class="row ghost-row" type="submit">
    <span></span>
    <div><div class="r-title">+ New workspace</div><div class="r-sub">Start a fresh empty workspace</div></div>
    <span></span>
  </button></form>`;

  const managedRepoRows = managedRepos.map((repo) => `<div class="row managed-repo-row">
    <span></span>
    <div><div class="r-title">${escapeHtml(repo.name)}</div><div class="r-sub">${escapeHtml(repo.remoteUrl ?? "remote unknown")}</div></div>
    <span></span>
  </div>`).join("");

  const addManagedRepoRow = `<button class="row ghost-row" type="button" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="add-managed-repo-modal">
    <span></span>
    <div><div class="r-title">+ Add managed repository</div><div class="r-sub">Create a bare clone in the Atelier data directory</div></div>
    <span></span>
  </button>`;

  return response(layout("Workspaces", `<div class="app no-sidebar">
  <div class="main">
    <header class="header"><h1>${escapeHtml(atelierName)} · Workspaces</h1></header>
    <div class="body">
      <div class="toolbar">
        <input class="search global-filter" placeholder="Filter workspaces…" data-controller="global-filter" data-action="input->global-filter#filter">
      </div>
      <div class="table">
        <div class="row head"><span></span><span>Workspace</span><span>Actions</span></div>
        <div id="workspaces_table_rows">${rows || `<div class="row" id="no_workspaces_row"><span></span><div><div class="r-title">No workspaces</div><div class="r-sub">Create one below.</div></div><span></span></div>`}</div>
        ${newWorkspaceRow}
      </div>

      <section class="host-repos">
        <div class="section-head">
          <div>
            <h2>Managed repositories</h2>
          </div>
        </div>
        <div class="table managed-repos-table">
          ${managedRepoRows || `<div class="row"><span></span><div><div class="r-title">No managed repositories</div><div class="r-sub">Add one below.</div></div><span></span></div>`}
          ${addManagedRepoRow}
        </div>
      </section>
    </div>
  </div>
</div>
${addManagedRepoModal()}`));
}

function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

function workspaceCreationFrameId(token: string): string {
  return domId("workspace_creation", token);
}

function workspaceInitializingFrame(token: string): string {
  return `<turbo-frame id="${workspaceCreationFrameId(token)}" src="/workspace-creations/${encodeURIComponent(token)}">${workspaceRow(token, "New workspace", "initializing")}</turbo-frame>`;
}

function workspaceCreateStream(): Response {
  const token = `initializing_${crypto.randomUUID()}`;
  pendingWorkspaceCreations.set(token, createWorkspaceWithDefaultAgent());
  return turboStreamResponse(`<turbo-stream action="remove" target="no_workspaces_row"></turbo-stream><turbo-stream action="append" target="workspaces_table_rows"><template>${workspaceInitializingFrame(token)}</template></turbo-stream>`);
}

async function workspaceCreationFrame(token: string): Promise<Response> {
  const pending = pendingWorkspaceCreations.get(token);
  if (!pending) return response(`<turbo-frame id="${workspaceCreationFrameId(token)}"><div class="row"><span class="dot err"></span><div><div class="r-title">Workspace creation not found</div><div class="r-sub">Try creating another workspace.</div></div><span></span></div></turbo-frame>`, { status: 404 });
  try {
    const created = await pending;
    return response(`<turbo-frame id="${workspaceCreationFrameId(token)}">${workspaceRow(created.id, `Workspace ${created.id}`)}</turbo-frame>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response(`<turbo-frame id="${workspaceCreationFrameId(token)}"><div class="row"><span class="dot err"></span><div><div class="r-title">Workspace creation failed</div><div class="r-sub">${escapeHtml(message)}</div></div><span></span></div></turbo-frame>`, { status: 500 });
  } finally {
    pendingWorkspaceCreations.delete(token);
  }
}

async function createWorkspaceFromForm(request: Request, url: URL): Promise<Response> {
  if (wantsTurboStream(request)) return workspaceCreateStream();
  const created = await createWorkspaceWithDefaultAgent();
  return Response.redirect(new URL(`/workspaces/${encodeURIComponent(created.id)}`, url).toString(), 303);
}

async function createManagedRepoFromForm(request: Request, url: URL): Promise<Response> {
  const formData = await request.formData();
  const gitUrl = String(formData.get("gitUrl") ?? "");
  await addManagedRepo(gitUrl);
  return Response.redirect(new URL("/workspaces", url).toString(), 303);
}

async function cloneManagedRepoIntoWorkspaceFromForm(id: string, request: Request, url: URL): Promise<Response> {
  const formData = await request.formData();
  const repo = String(formData.get("repo") ?? "");
  await cloneManagedRepoIntoWorkspace(id, repo);
  return Response.redirect(new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString(), 303);
}

async function getWorkspaceTitle(id: string): Promise<string> {
  const { workspaces } = await listWorkspaces();
  const workspace = workspaces.find((candidate) => candidate.id === id);
  return workspace?.title || `Workspace ${id}`;
}

function workspaceTitleFrame(id: string, title: string): string {
  const frameId = domId("workspace_title", id);
  return `<turbo-frame id="${frameId}"><h1><a class="editable-title" href="/workspaces/${encodeURIComponent(id)}/title/edit" data-turbo-frame="${frameId}" title="Edit workspace title">${escapeHtml(title)}</a></h1></turbo-frame>`;
}

async function workspaceTitleEditFrame(id: string): Promise<Response> {
  const title = await getWorkspaceTitle(id);
  const frameId = domId("workspace_title", id);
  return response(`<turbo-frame id="${frameId}">
    <form class="workspace-title-form" method="post" action="/workspaces/${encodeURIComponent(id)}/title">
      <input name="title" value="${escapeHtml(title)}" aria-label="Workspace title" autofocus>
      <button class="btn sm primary" type="submit">Save</button>
      <a class="btn sm" href="/workspaces/${encodeURIComponent(id)}/title" data-turbo-frame="${frameId}">Cancel</a>
    </form>
  </turbo-frame>`);
}

async function workspaceTitleShowFrame(id: string): Promise<Response> {
  return response(workspaceTitleFrame(id, await getWorkspaceTitle(id)));
}

async function updateWorkspaceTitleFromForm(id: string, request: Request): Promise<Response> {
  const formData = await request.formData();
  const title = String(formData.get("title") ?? "").trim();
  await setWorkspaceTitle(id, title);
  return response(workspaceTitleFrame(id, title || `Workspace ${id}`));
}

interface WorkspaceTab {
  key: string;
  tabHtml: string;
  paneHtml: string;
  footerHtml?: string;
}

function staticWorkspaceTab(key: string, label: string, paneHtml: string, options: { active?: boolean } = {}): WorkspaceTab {
  return {
    key,
    tabHtml: `<button class="tab ${options.active ? "active" : "muted"}" data-tab="${escapeHtml(key)}" data-action="click->workspace-tabs#activate" data-workspace-tabs-tab-param="${escapeHtml(key)}" type="button">${escapeHtml(label)}</button>`,
    paneHtml: `<section class="tab-pane ${options.active ? "active" : ""}" data-tab-pane="${escapeHtml(key)}">${paneHtml}</section>`,
  };
}

async function workspacePage(id: string): Promise<Response> {
  const [{ repos }, title, { terminals }, { repos: managedRepos }, agents] = await Promise.all([listWorkspaceRepos(id), getWorkspaceTitle(id), listWorkspaceTerminals(id), listManagedRepos(), listOrCreateWorkspaceAgents(id)]);
  const agentTabEntries = renderWorkspaceAgentTabs(id, agents);
  const terminalTabEntries: WorkspaceTab[] = renderWorkspaceTerminalTabs(id, terminals);
  const codeTab = staticWorkspaceTab("code", "⌘ Code", `<div class="workspace-wide"><div class="panel"><div class="pad">Code pane will be wired up in a later slice.</div></div></div>`);
  const commitsTab = staticWorkspaceTab("commits", "▧ Commits", `<div class="workspace-wide"><div class="panel"><div class="pad">Commits pane will be wired up in a later slice.</div></div></div>`);
  const workspaceTabs = [...agentTabEntries, ...terminalTabEntries, codeTab, commitsTab];
  const terminalFooterActions = terminalTabEntries.map((tab) => tab.footerHtml ?? "").join("");
  const repoRows = repos.map((repo) => {
    const frameId = domId("repo_mergeability", id, repo);
    return `<turbo-frame id="${frameId}" src="/workspaces/${encodeURIComponent(id)}/repos/${encodeURIComponent(repo)}/mergeability">
      <div class="git-status-row fetching">
        <div class="repo-identity"><span class="repo-dot"></span><b>${escapeHtml(repo)}</b><small>Fetching origin and checking mergeability…</small></div>
        <span class="status-spinner" aria-label="Checking"></span>
      </div>
    </turbo-frame>`;
  }).join("") || `<div class="git-status-row idle"><div class="repo-identity"><span class="repo-dot"></span><b>No repos</b><small>No git repositories found under /repos.</small></div></div>`;
  const cloneRepoRow = `<button class="git-status-row clone-row" type="button" data-controller="modal-opener" data-action="modal-opener#open" data-modal-opener-target-id-value="clone-managed-repo-modal"><div class="repo-identity"><span class="clone-plus">+</span><small>Clone a managed repository into this workspace.</small></div><span></span></button>`;

  return response(layout(title, `<div class="app no-sidebar">
  <div class="main">
    <header class="header workspace-header">
      <div class="workspace-titlebar">
        <span class="crumb"><a href="/workspaces">Workspaces</a> ›</span>
        ${workspaceTitleFrame(id, title)}
      </div>
      <div class="workspace-tabs" id="tabs" data-controller="workspace-tabs" data-workspace-tabs-workspace-id-value="${escapeHtml(id)}">
        ${agentTabEntries.map((tab) => tab.tabHtml).join("")}
        <form class="contents" id="add_agent_form" method="post" action="/workspaces/${encodeURIComponent(id)}/agents"><button class="tab muted" id="add-agent" type="submit">+ Agent</button></form>
        ${terminalTabEntries.map((tab) => tab.tabHtml).join("")}
        <form class="contents" id="add_terminal_form" method="post" action="/workspaces/${encodeURIComponent(id)}/terminals"><button class="tab muted" id="add-terminal" type="submit">+ Terminal</button></form>
        ${codeTab.tabHtml}
        ${commitsTab.tabHtml}
      </div>
      <div class="header-actions">${deleteWorkspaceForm(id, "/workspaces")}</div>
    </header>

    <div class="body wide workspace-body">
      <div class="workspace-panes" id="workspace_panes">
        ${workspaceTabs.map((tab) => tab.paneHtml).join("")}
      </div>

      <div class="workspace-footer">
        <div class="terminal-footer-actions" id="terminal_footer_actions">${terminalFooterActions}</div>
        <section class="git-status-widget" aria-label="Git integration status">
          <div class="git-status-head"><strong>Git status</strong></div>
          ${repoRows}
          ${cloneRepoRow}
        </section>
      </div>
    </div>
  </div>
</div>
${cloneManagedRepoModal(id, managedRepos, repos)}`));
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

function errorJsonResponse(error: unknown, status = 500): Response {
  if (error instanceof AtelierCoreError) {
    return jsonResponse({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ ok: false, error: { code: "internal_error", message } }, { status });
}

async function deleteWorkspaceEndpoint(id: string, force: boolean, request: Request): Promise<Response> {
  const formData = await request.formData().catch(() => undefined);
  const returnTo = formData ? String(formData.get("returnTo") ?? "") : "";
  try {
    await deleteWorkspace(id, { force });
    if (wantsTurboStream(request)) {
      const redirect = returnTo ? `<turbo-stream action="append" target="body"><template><div data-controller="redirect" data-redirect-url-value="${escapeHtml(returnTo)}"></div></template></turbo-stream>` : "";
      return turboStreamResponse(`<turbo-stream action="remove" target="delete-workspace-modal"></turbo-stream><turbo-stream action="remove" target="${domId("workspace_row", id)}"></turbo-stream>${redirect}`);
    }
    return jsonResponse({ ok: true, result: null });
  } catch (error) {
    const status = error instanceof AtelierCoreError && error.code === "workspace_delete_blocked" ? 409 : 500;
    if (wantsTurboStream(request) && error instanceof AtelierCoreError && error.code === "workspace_delete_blocked") {
      return turboStreamResponse(`<turbo-stream action="remove" target="delete-workspace-modal"></turbo-stream><turbo-stream action="append" target="body"><template>${deleteBlockedModal(id, error.details, returnTo)}</template></turbo-stream>`);
    }
    return errorJsonResponse(error, status);
  }
}

type SocketData = TerminalSocketData | AgentSocketData;

async function validateSocket(url: URL): Promise<SocketData | undefined> {
  return (await validateAgentSocket(url)) ?? (await validateTerminalSocket(url));
}

function errorPage(error: unknown): Response {
  const status = error instanceof AtelierCoreError && ["workspace_not_found", "repo_not_found", "terminal_not_found", "agent_not_found"].includes(error.code) ? 404 : 500;
  const message = error instanceof Error ? error.message : String(error);
  return response(layout("Error", `<div class="app no-sidebar"><div class="main"><header class="header"><h1>Error</h1></header><div class="body"><p>${escapeHtml(message)}</p><p><a class="btn" href="/workspaces">Back to workspaces</a></p></div></div></div>`), { status });
}

function routeParams(pathname: string):
  | { route: "workspace"; id: string }
  | { route: "mergeability"; id: string; repo: string }
  | undefined {
  const workspaceMatch = pathname.match(/^\/workspaces\/([^/]+)$/);
  if (workspaceMatch) return { route: "workspace", id: decodeURIComponent(workspaceMatch[1]) };

  const mergeabilityMatch = pathname.match(/^\/workspaces\/([^/]+)\/repos\/([^/]+)\/mergeability$/);
  if (mergeabilityMatch) {
    return {
      route: "mergeability",
      id: decodeURIComponent(mergeabilityMatch[1]),
      repo: decodeURIComponent(mergeabilityMatch[2]),
    };
  }

  return undefined;
}

const maxPortAttempts = 100;
let serverPort = 0;

for (let attempt = 0; attempt < maxPortAttempts; attempt++) {
  const port = requestedPort === 0 ? 0 : requestedPort + attempt;

  try {
    const server = Bun.serve<SocketData>({
      hostname,
      port,
  async fetch(request, server) {
    const url = new URL(request.url);
    const staticResponse = await serveStatic(url.pathname);
    if (staticResponse) return staticResponse;

    try {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const socketData = await validateSocket(url);
        if (!socketData) return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        if (server.upgrade(request, { data: socketData })) return undefined;
        return response("websocket upgrade failed", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/") return Response.redirect(new URL("/workspaces", url).toString(), 302);
      if (url.pathname === "/workspaces" && request.method === "GET") return await workspacesPage();
      if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceFromForm(request, url);
      if (url.pathname === "/managed-repos" && request.method === "POST") return await createManagedRepoFromForm(request, url);

      const workspaceCreationMatch = url.pathname.match(/^\/workspace-creations\/([^/]+)$/);
      if (workspaceCreationMatch && request.method === "GET") return await workspaceCreationFrame(decodeURIComponent(workspaceCreationMatch[1]));

      const titleEditMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/title\/edit$/);
      if (titleEditMatch && request.method === "GET") return await workspaceTitleEditFrame(decodeURIComponent(titleEditMatch[1]));

      const titleMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/title$/);
      if (titleMatch && request.method === "GET") return await workspaceTitleShowFrame(decodeURIComponent(titleMatch[1]));
      if (titleMatch && request.method === "POST") return await updateWorkspaceTitleFromForm(decodeURIComponent(titleMatch[1]), request);

      const agentsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/agents$/);
      if (agentsMatch && request.method === "POST") return await createAgentEndpoint(decodeURIComponent(agentsMatch[1]), request);

      const terminalsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/terminals$/);
      if (terminalsMatch && request.method === "GET") return await listTerminalsEndpoint(decodeURIComponent(terminalsMatch[1]));
      if (terminalsMatch && request.method === "POST") return await createTerminalEndpoint(decodeURIComponent(terminalsMatch[1]), request);

      const cloneManagedRepoMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/clone-managed-repo$/);
      if (cloneManagedRepoMatch && request.method === "POST") return await cloneManagedRepoIntoWorkspaceFromForm(decodeURIComponent(cloneManagedRepoMatch[1]), request, url);

      const repoPushMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/repos\/([^/]+)\/push$/);
      if (repoPushMatch && request.method === "POST") return await pushRepoEndpoint(decodeURIComponent(repoPushMatch[1]), decodeURIComponent(repoPushMatch[2]), request);

      const terminalDeleteMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/terminals\/([^/]+)\/delete$/);
      if (terminalDeleteMatch && request.method === "POST") return await deleteTerminalEndpoint(decodeURIComponent(terminalDeleteMatch[1]), decodeURIComponent(terminalDeleteMatch[2]), request);

      const workspaceDeleteMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/delete$/);
      if (workspaceDeleteMatch && request.method === "POST") return await deleteWorkspaceEndpoint(decodeURIComponent(workspaceDeleteMatch[1]), url.searchParams.get("force") === "1", request);

      const params = routeParams(url.pathname);
      if (params?.route === "workspace") return await workspacePage(params.id);
      if (params?.route === "mergeability") return await mergeabilityFrame(params.id, params.repo);

      return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (error) {
      return errorPage(error);
    }
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "terminal") openTerminalSocket(ws as ServerWebSocket<TerminalSocketData>);
      if (ws.data.kind === "agent") void openAgentSocket(ws as ServerWebSocket<AgentSocketData>);
    },
    message(ws, message) {
      if (ws.data.kind === "terminal") handleTerminalSocketMessage(ws as ServerWebSocket<TerminalSocketData>, message);
      if (ws.data.kind === "agent") void handleAgentSocketMessage(ws as ServerWebSocket<AgentSocketData>, message);
    },
    close(ws) {
      if (ws.data.kind === "terminal") closeTerminalSocket(ws as ServerWebSocket<TerminalSocketData>);
      if (ws.data.kind === "agent") closeAgentSocket(ws as ServerWebSocket<AgentSocketData>);
    },
  },
    });
    serverPort = server.port ?? port;
    break;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EADDRINUSE" || requestedPort === 0) throw error;
  }
}

if (serverPort === 0) throw new Error(`No available port found from ${requestedPort} through ${requestedPort + maxPortAttempts - 1}`);

console.log(`${atelierName} web listening on http://${hostname}:${serverPort}`);
