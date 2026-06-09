import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerWebSocket } from "bun";
import {
  closeAgentSocket,
  createNextWorkspaceAgent,
  agentWorkspaceModule,
  ensureDefaultWorkspaceAgent,
  handleAgentSocketMessage,
  openAgentSocket,
  subscribeWorkspaceTabBusy,
  validateAgentSocket,
  type AgentSocketData,
} from "@atelier/agent/server";
import {
  containerHealthStaticFiles,
  containerHealthStreamEndpoint,
  containerHealthWorkspaceModule,
  healthPaneEndpoint,
} from "@atelier/container-health/server";
import {
  AtelierCoreError,
  addManagedRepo,
  cloneManagedRepoIntoWorkspace,
  createAtelierEventBus,
  defaultDataDir,
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
import { registerPiConfigEvents } from "@atelier/pi-config/server";
import {
  closeTerminalSocket,
  createWorkspaceTerminal,
  handleTerminalSocketMessage,
  openTerminalSocket,
  registerTerminalEvents,
  subscribeTerminalTabBusy,
  terminalStaticFiles,
  terminalWorkspaceModule,
  validateTerminalSocket,
  type TerminalSocketData,
} from "@atelier/terminal/server";
import { atelierName, type WorkspaceAttachment, type WorkspaceModule, type WorkspaceTabContribution } from "@atelier/shared";

const requestedPort = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
const atelierEvents = createAtelierEventBus();
registerPiConfigEvents(atelierEvents);
registerTerminalEvents(atelierEvents);

interface WorkspaceGroupState {
  id: string;
  tabs: string[];
  activeTab?: string;
  size: number;
}

interface WorkspaceLayoutState {
  groups: WorkspaceGroupState[];
}

const workspaceLayouts = new Map<string, WorkspaceLayoutState>();

async function createWorkspaceWithDefaultAgent(): Promise<{ id: string }> {
  const created = await createWorkspace();
  await Promise.all([
    ensureDefaultWorkspaceAgent(created.id),
    markWorkspaceUserActivity(created.id, { broadcast: false }),
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
<link rel="stylesheet" href="/container-health.css">
<script type="module" src="https://cdn.jsdelivr.net/npm/@hotwired/turbo@8.0.13/dist/turbo.es2017-esm.js"></script>
<script type="module">
  import { Application, Controller } from "https://cdn.jsdelivr.net/npm/@hotwired/stimulus@3.2.2/+esm";
  window.Stimulus = { Application, Controller };
</script>
<script type="module" src="/workspace.js"></script>
</head>
<body id="body">${body}
<div data-controller="workspace-events-stream" hidden></div>
</body>
</html>`;
}

async function serveStatic(pathname: string): Promise<Response | undefined> {
  const staticFiles: Record<string, { url: URL; contentType: string }> = {
    "/style.css": { url: new URL("../../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/workspace.js": { url: new URL("../../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
    ...terminalStaticFiles,
    ...containerHealthStaticFiles,
  };
  const entry = staticFiles[pathname];
  if (!entry) return undefined;
  const file = Bun.file(entry.url);
  if (!(await file.exists())) return response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(file, { headers: { "content-type": entry.contentType } });
}

type WorkspaceActivityState = Record<string, number>;

let workspaceActivityCache: WorkspaceActivityState | undefined;
const workspaceEventSubscribers = new Set<(html: string) => void>();
const workspaceTabBusy = new Map<string, Map<string, boolean>>();

function workspaceActivityPath(): string {
  return join(defaultDataDir(), "view-state", "workspace-activity.json");
}

async function readWorkspaceActivity(): Promise<WorkspaceActivityState> {
  if (workspaceActivityCache) return workspaceActivityCache;
  try {
    const parsed = JSON.parse(await readFile(workspaceActivityPath(), "utf8"));
    workspaceActivityCache = parsed && typeof parsed === "object" ? parsed as WorkspaceActivityState : {};
  } catch {
    workspaceActivityCache = {};
  }
  return workspaceActivityCache;
}

async function writeWorkspaceActivity(activity: WorkspaceActivityState): Promise<void> {
  const path = workspaceActivityPath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(activity, null, 2)}\n`);
  await rename(tempPath, path);
}

async function markWorkspaceUserActivity(workspaceId: string, options: { broadcast?: boolean } = {}): Promise<void> {
  const activity = await readWorkspaceActivity();
  activity[workspaceId] = Date.now();
  await writeWorkspaceActivity(activity);
  if (options.broadcast !== false) await broadcastWorkspaceRows();
}

async function listWorkspacesByRecentActivity(): Promise<Awaited<ReturnType<typeof listWorkspaces>>["workspaces"]> {
  const [{ workspaces }, activity] = await Promise.all([listWorkspaces(), readWorkspaceActivity()]);
  return [...workspaces].sort((a, b) => (activity[b.id] ?? 0) - (activity[a.id] ?? 0));
}

function workspaceStatusId(workspaceId: string): string {
  return domId("workspace_status", workspaceId);
}

function workspaceTabStatusId(workspaceId: string, tabKey: string): string {
  return domId("workspace_tab_status", workspaceId, tabKey);
}

function isTabBusy(workspaceId: string, tabKey: string): boolean {
  return workspaceTabBusy.get(workspaceId)?.get(tabKey) ?? false;
}

function isWorkspaceBusy(workspaceId: string): boolean {
  return [...(workspaceTabBusy.get(workspaceId)?.values() ?? [])].some(Boolean);
}

function renderWorkspaceStatus(workspaceId: string): string {
  return `<span id="${workspaceStatusId(workspaceId)}" class="workspace-status">${isWorkspaceBusy(workspaceId) ? `<span class="status-spinner sm" aria-label="Workspace busy" title="Workspace busy"></span>` : ""}</span>`;
}

function renderTabStatus(workspaceId: string, tabKey: string): string {
  return `<span id="${workspaceTabStatusId(workspaceId, tabKey)}" class="tab-status">${isTabBusy(workspaceId, tabKey) ? `<span class="status-spinner sm" aria-label="Tab busy" title="Tab busy"></span>` : ""}</span>`;
}

function workspaceStatusStreams(workspaceId: string, tabKey?: string): string {
  return `${turboReplaceStream(workspaceStatusId(workspaceId), renderWorkspaceStatus(workspaceId))}${tabKey ? turboReplaceStream(workspaceTabStatusId(workspaceId, tabKey), renderTabStatus(workspaceId, tabKey)) : ""}`;
}

function setWorkspaceTabBusy(workspaceId: string, tabKey: string, busy: boolean): void {
  let tabs = workspaceTabBusy.get(workspaceId);
  if (!tabs) {
    tabs = new Map();
    workspaceTabBusy.set(workspaceId, tabs);
  }
  if ((tabs.get(tabKey) ?? false) === busy) return;
  if (busy) tabs.set(tabKey, true);
  else tabs.delete(tabKey);
  if (tabs.size === 0) workspaceTabBusy.delete(workspaceId);
  broadcastTurboStream(workspaceStatusStreams(workspaceId, tabKey));
}

function turboReplaceStream(target: string, html: string): string {
  return `<turbo-stream action="replace" target="${escapeHtml(target)}"><template>${html}</template></turbo-stream>`;
}

function broadcastTurboStream(html: string): void {
  for (const subscriber of workspaceEventSubscribers) subscriber(html);
}

async function broadcastWorkspaceRows(): Promise<void> {
  broadcastTurboStream(turboReplaceStream("workspaces_table_rows", await renderWorkspaceRows()));
}

function currentWorkspaceStatusStreams(): string {
  return [...workspaceTabBusy.entries()].map(([workspaceId, tabs]) => `${workspaceStatusStreams(workspaceId)}${[...tabs.keys()].map((tabKey) => turboReplaceStream(workspaceTabStatusId(workspaceId, tabKey), renderTabStatus(workspaceId, tabKey))).join("")}`).join("");
}

async function workspaceEventsStream(): Promise<Response> {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let send: ((html: string) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (html: string) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(html)}\n\n`));
      workspaceEventSubscribers.add(send);
      const initialStatus = currentWorkspaceStatusStreams();
      if (initialStatus) send(initialStatus);
      keepalive = setInterval(() => controller.enqueue(encoder.encode(`: keepalive\n\n`)), 5000);
    },
    cancel() {
      if (send) workspaceEventSubscribers.delete(send);
      if (keepalive) clearInterval(keepalive);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "connection": "keep-alive" } });
}

atelierEvents.on("workspace_user_activity", ({ workspaceId }) => {
  void markWorkspaceUserActivity(workspaceId).catch((error) => console.error("could not record workspace activity", error));
});

atelierEvents.on("workspace_title_changed", ({ workspaceId, title }) => {
  broadcastTurboStream(turboReplaceStream(domId("workspace_sidebar_title", workspaceId), workspaceSidebarTitleFrame(workspaceId, title || `Workspace ${workspaceId}`)));
});

subscribeWorkspaceTabBusy(({ workspaceId, tabKey, busy }) => setWorkspaceTabBusy(workspaceId, tabKey, busy));
subscribeTerminalTabBusy(({ workspaceId, tabKey, busy }) => setWorkspaceTabBusy(workspaceId, tabKey, busy));

function workspaceSidebarTitleFrame(id: string, title: string): string {
  const frameId = domId("workspace_sidebar_title", id);
  return `<turbo-frame id="${frameId}" class="workspace-row-title-frame">
    <a class="row-main" href="/workspaces/${encodeURIComponent(id)}" data-action="workspace-list#select"><div class="r-title">${escapeHtml(title)}</div></a>
    <a class="workspace-row-edit" href="/workspaces/${encodeURIComponent(id)}/sidebar-title/edit" data-turbo-frame="${frameId}" title="Rename workspace">✎</a>
  </turbo-frame>`;
}

function workspaceRow(id: string, title: string, state: "ready" | "initializing" = "ready", options: { active?: boolean } = {}): string {
  const initializing = state === "initializing";
  return `<div class="row workspace-row ${initializing ? "initializing" : ""} ${options.active ? "active" : ""}" id="${domId("workspace_row", id)}" data-workspace-id="${escapeHtml(id)}">
      ${initializing ? `<span class="dot wait"></span>` : renderWorkspaceStatus(id)}
      ${initializing ? `<div class="row-main"><div class="r-title">${escapeHtml(title)}</div><div class="r-sub">Initializing workspace…</div></div><span class="row-actions"><span class="status-spinner" aria-label="Initializing"></span></span>` : `${workspaceSidebarTitleFrame(id, title)}<form class="workspace-row-delete" method="post" action="/workspaces/${encodeURIComponent(id)}/delete" data-action="submit->workspace-list#delete"><input type="hidden" name="selected" value="${options.active ? "1" : "0"}"><button type="submit" title="Delete workspace" aria-label="Delete workspace">🗑</button></form>`}
    </div>`;
}

function deleteBlockedModal(id: string, details: unknown, options: { returnTo?: string; selected?: boolean } = {}): string {
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
    <form id="force-delete-workspace-form" method="post" action="/workspaces/${encodeURIComponent(id)}/delete?force=1">${options.returnTo ? `<input type="hidden" name="returnTo" value="${escapeHtml(options.returnTo)}">` : ""}${options.selected ? `<input type="hidden" name="selected" value="1">` : ""}</form>
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

async function renderWorkspaceRows(selectedId?: string): Promise<string> {
  const workspaces = await listWorkspacesByRecentActivity();
  return workspaces
    .map((workspace) => workspaceRow(workspace.id, workspace.title || `Workspace ${workspace.id}`, "ready", { active: workspace.id === selectedId }))
    .join("");
}

async function renderWorkspaceSidebar(selectedId?: string): Promise<string> {
  const [{ repos: managedRepos }, rows] = await Promise.all([listManagedRepos(), renderWorkspaceRows(selectedId)]);

  const newWorkspaceRow = `<form class="contents" method="post" action="/workspaces"><button class="row ghost-row" type="submit">
    <span></span>
    <div><div class="r-title">+ New workspace</div></div>
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

  return `<turbo-frame id="workspace_sidebar" data-controller="workspace-list">
    <div class="sidebar-header">
      <h1>${escapeHtml(atelierName)}</h1>
      <input class="search global-filter" placeholder="Filter…" data-controller="global-filter" data-action="input->global-filter#filter">
    </div>
    <div class="table workspace-sidebar-table">
      <div id="workspaces_table_rows">${rows || `<div class="row" id="no_workspaces_row"><span></span><div><div class="r-title">No workspaces</div><div class="r-sub">Create one below.</div></div><span></span></div>`}</div>
      ${newWorkspaceRow}
    </div>

    <section class="host-repos sidebar-host-repos">
      <div class="section-head"><div><h2>Managed repositories</h2></div></div>
      <div class="table managed-repos-table">
        ${managedRepoRows || `<div class="row"><span></span><div><div class="r-title">No managed repositories</div><div class="r-sub">Add one below.</div></div><span></span></div>`}
        ${addManagedRepoRow}
      </div>
    </section>
  </turbo-frame>`;
}

function renderWorkspaceEmptyDetail(): string {
  return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-residency" data-workspace-residency-max-resident-value="10"><div class="main"><header class="header"><h1>Select a workspace</h1></header><div class="body"><div class="panel"><div class="pad">Create or select a workspace to begin.</div></div></div></div></div>`;
}

async function workspaceDetailHostHtml(selectedId: string): Promise<string> {
  return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-residency" data-workspace-residency-max-resident-value="10">${await workspaceDetailResidentHtml(selectedId, { active: true })}</div>`;
}

async function renderWorkspaceShell(selectedId?: string): Promise<string> {
  const detail = selectedId ? await workspaceDetailHostHtml(selectedId) : renderWorkspaceEmptyDetail();
  return `<div class="app workspace-shell">
    <aside class="workspace-shell-sidebar">${await renderWorkspaceSidebar(selectedId)}</aside>
    <main class="workspace-shell-main">${detail}</main>
  </div>
  ${addManagedRepoModal()}`;
}

async function homePage(): Promise<Response> {
  const workspaces = await listWorkspacesByRecentActivity();
  return response(layout("Workspaces", await renderWorkspaceShell(workspaces[0]?.id)));
}

function wantsTurboStream(request: Request): boolean {
  return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html") ?? false;
}

function workspaceCreationFrameId(token: string): string {
  return domId("workspace_creation", token);
}

function workspaceInitializingFrame(token: string): string {
  return `<turbo-frame id="${workspaceCreationFrameId(token)}">${workspaceRow(token, "Initializing", "initializing", { active: true })}</turbo-frame>`;
}

function workspaceCreateStream(): Response {
  const token = `initializing_${crypto.randomUUID()}`;
  void (async () => {
    try {
      const created = await createWorkspaceWithDefaultAgent();
      const workspaceUrl = `/workspaces/${encodeURIComponent(created.id)}`;
      broadcastTurboStream(`<turbo-stream action="replace" target="${workspaceCreationFrameId(token)}"><template>${workspaceRow(created.id, `Workspace ${created.id}`, "ready", { active: true })}</template></turbo-stream><turbo-stream action="replace" target="workspace_sidebar"><template>${await renderWorkspaceSidebar(created.id)}</template></turbo-stream><turbo-stream action="replace" target="workspace_detail"><template>${await workspaceDetailHostHtml(created.id)}</template></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="redirect" data-redirect-url-value="${workspaceUrl}" data-redirect-mode-value="replace"></div></template></turbo-stream>`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      broadcastTurboStream(`<turbo-stream action="replace" target="${workspaceCreationFrameId(token)}"><template><div class="row"><span class="dot err"></span><div><div class="r-title">Workspace creation failed</div><div class="r-sub">${escapeHtml(message)}</div></div><span></span></div></template></turbo-stream>`);
    } finally {
      pendingWorkspaceCreations.delete(token);
    }
  })();
  return turboStreamResponse(`<turbo-stream action="remove" target="no_workspaces_row"></turbo-stream><turbo-stream action="prepend" target="workspaces_table_rows"><template>${workspaceInitializingFrame(token)}</template></turbo-stream>`, { status: 202 });
}

async function createWorkspaceFromForm(request: Request, url: URL): Promise<Response> {
  if (wantsTurboStream(request)) return workspaceCreateStream();
  const created = await createWorkspaceWithDefaultAgent();
  return Response.redirect(new URL("/", url).toString(), 303);
}

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

async function getWorkspaceTitle(id: string): Promise<string> {
  const { workspaces } = await listWorkspaces();
  const workspace = workspaces.find((candidate) => candidate.id === id);
  return workspace?.title || `Workspace ${id}`;
}

async function workspaceSidebarTitleEditFrame(id: string): Promise<Response> {
  const title = await getWorkspaceTitle(id);
  const frameId = domId("workspace_sidebar_title", id);
  return response(`<turbo-frame id="${frameId}" class="workspace-row-title-frame">
    <form class="workspace-sidebar-title-form" method="post" action="/workspaces/${encodeURIComponent(id)}/sidebar-title" data-controller="workspace-title-edit" data-workspace-title-edit-cancel-url-value="/workspaces/${encodeURIComponent(id)}/sidebar-title" data-action="keydown->workspace-title-edit#keydown">
      <input name="title" value="${escapeHtml(title)}" aria-label="Workspace title" autofocus>
    </form>
  </turbo-frame>`);
}

async function workspaceSidebarTitleShowFrame(id: string): Promise<Response> {
  return response(workspaceSidebarTitleFrame(id, await getWorkspaceTitle(id)));
}

async function updateWorkspaceSidebarTitleFromForm(id: string, request: Request): Promise<Response> {
  const formData = await request.formData();
  const title = String(formData.get("title") ?? "").trim();
  await setWorkspaceTitle(id, title);
  return response(workspaceSidebarTitleFrame(id, title || `Workspace ${id}`));
}

const workspaceModules: WorkspaceModule[] = [agentWorkspaceModule, terminalWorkspaceModule, containerHealthWorkspaceModule];

async function attachWorkspaceModules(workspaceId: string): Promise<WorkspaceAttachment[]> {
  return await Promise.all(workspaceModules.map((module) => module.attachToWorkspace({ workspaceId })));
}

function tabLabel(tab: WorkspaceTabContribution): string {
  const html = tab.tabHtml;
  const closeIndex = html.lastIndexOf("</");
  const openIndex = closeIndex > 0 ? html.lastIndexOf(">", closeIndex) : html.lastIndexOf(">");
  const text = openIndex >= 0 ? html.slice(openIndex + 1, closeIndex > openIndex ? closeIndex : undefined) : html;
  return text.replace(/<[^>]+>/g, "").replace(/^\s*[+◈⌘▧▣]\s*/, "").trim() || tab.key;
}

function workspaceGroupsId(workspaceId: string): string {
  return domId("workspace_groups", workspaceId);
}

function normalizeWorkspaceLayout(workspaceId: string, tabs: WorkspaceTabContribution[]): WorkspaceLayoutState {
  const keys = tabs.map((tab) => tab.key);
  const keySet = new Set(keys);
  let layout = workspaceLayouts.get(workspaceId);
  if (!layout || layout.groups.length === 0) {
    layout = { groups: [{ id: crypto.randomUUID(), tabs: [...keys], activeTab: keys[0], size: 1 }] };
    workspaceLayouts.set(workspaceId, layout);
    return layout;
  }
  const assigned = new Set(layout.groups.flatMap((group) => group.tabs));
  const missing = keys.filter((key) => !assigned.has(key));
  layout.groups[0]?.tabs.push(...missing);
  for (const group of layout.groups) {
    group.tabs = group.tabs.filter((key) => keySet.has(key));
    if (!group.activeTab || !group.tabs.includes(group.activeTab)) group.activeTab = group.tabs[0];
  }
  normalizeGroupSizes(layout);
  return layout;
}

function normalizeGroupSizes(layout: WorkspaceLayoutState): void {
  const total = layout.groups.reduce((sum, group) => sum + (Number.isFinite(group.size) && group.size > 0 ? group.size : 1), 0) || 1;
  for (const group of layout.groups) group.size = (Number.isFinite(group.size) && group.size > 0 ? group.size : 1) / total;
}

function renderTabPane(tab: WorkspaceTabContribution, active: boolean): string {
  if (!tab.paneHtml) return "";
  return tab.paneHtml.replace(/class="tab-pane([^\"]*)"/, (_match, classes: string) => {
    const classList = String(classes).replace(/\bactive\b/g, "").trim();
    return `class="tab-pane${classList ? ` ${classList}` : ""}${active ? " active" : ""}"`;
  });
}

function renderWorkspaceGroups(workspaceId: string, tabs: WorkspaceTabContribution[], attachments: WorkspaceAttachment[]): string {
  const layout = normalizeWorkspaceLayout(workspaceId, tabs);
  const tabByKey = new Map(tabs.map((tab) => [tab.key, tab]));
  const actions = attachments.flatMap((attachment) => attachment.tabActions ?? []);
  const actionMenu = (group: WorkspaceGroupState, index: number) => `<details class="group-add-menu"><summary class="group-icon-btn" title="Add tab or group">+</summary><div class="group-menu-panel">
      ${actions.map((action) => `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/actions/${encodeURIComponent(action.key)}"><button type="submit">${escapeHtml(action.label)}</button></form>`).join("")}
      <form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/split"><button type="submit">New Group</button></form>
      ${layout.groups.length > 1 && index > 0 ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/close"><button type="submit">Close Group</button></form>` : ""}
    </div></details>`;
  const groups = layout.groups.map((group, index) => {
    const activeTab = group.activeTab && group.tabs.includes(group.activeTab) ? group.activeTab : group.tabs[0];
    const headers = group.tabs.map((key, tabIndex) => {
      const tab = tabByKey.get(key);
      if (!tab) return "";
      return `<button class="group-tab ${key === activeTab ? "active" : "muted"}" draggable="true" data-tab="${escapeHtml(key)}" data-action="click->workspace-tabs#activate dragstart->workspace-groups#dragStart dragend->workspace-groups#dragEnd dragover->workspace-groups#dragOver drop->workspace-groups#drop" data-workspace-tabs-tab-param="${escapeHtml(key)}" data-group-id="${escapeHtml(group.id)}" data-tab-index="${tabIndex}" type="button"><span>${escapeHtml(tabLabel(tab))}</span>${renderTabStatus(workspaceId, key)}</button>`;
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
      <div class="workspace-panes" id="${domId("workspace_panes", workspaceId, group.id)}">${empty ? `<div class="empty-group"><p>This group is empty.</p>${layout.groups.length > 1 ? `<form data-turbo="true" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/groups/${encodeURIComponent(group.id)}/remove"><button class="btn sm" type="submit">Remove Empty Group</button></form>` : ""}</div>` : panes}</div>
      ${index === layout.groups.length - 1 ? `<div class="new-group-drop-zone" data-new-group-drop-zone="true" data-action="dragover->workspace-groups#dragOver dragleave->workspace-groups#dragLeave drop->workspace-groups#drop" title="Drop here to create a new group" aria-label="Drop tab here to create a new group"></div>` : ""}
    </section>${index < layout.groups.length - 1 ? `<div class="group-resizer" data-action="pointerdown->workspace-groups#startResize" data-resizer-index="${index}" role="separator" aria-orientation="vertical"></div>` : ""}`;
  }).join("");
  return `<div class="workspace-groups" id="${workspaceGroupsId(workspaceId)}" data-controller="workspace-groups" data-workspace-groups-workspace-id-value="${escapeHtml(workspaceId)}">${groups}</div>`;
}

async function workspaceTabsAndAttachments(workspaceId: string): Promise<{ attachments: WorkspaceAttachment[]; tabs: WorkspaceTabContribution[] }> {
  const attachments = await attachWorkspaceModules(workspaceId);
  return { attachments, tabs: attachments.flatMap((attachment) => attachment.tabs ?? []) };
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

async function workspaceDetailFrameHtml(id: string): Promise<string> {
  return `<turbo-frame id="workspace_detail">${await workspaceDetailContent(id)}</turbo-frame>`;
}

async function workspacePage(id: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("resident") === "1") return response(await workspaceDetailResidentHtml(id, { active: true }));
  if (request.headers.get("Turbo-Frame") === "workspace_detail") return response(await workspaceDetailFrameHtml(id));
  return response(layout(await getWorkspaceTitle(id), await renderWorkspaceShell(id)));
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

async function replaceWorkspaceGroupsStream(workspaceId: string): Promise<Response> {
  return turboStreamResponse(`<turbo-stream action="replace" target="${workspaceGroupsId(workspaceId)}"><template>${await renderWorkspaceGroupsFor(workspaceId)}</template></turbo-stream>`);
}

async function workspaceLayoutFor(workspaceId: string): Promise<WorkspaceLayoutState> {
  return normalizeWorkspaceLayout(workspaceId, (await workspaceTabsAndAttachments(workspaceId)).tabs);
}

async function splitWorkspaceGroupEndpoint(workspaceId: string, groupId: string): Promise<Response> {
  const layout = await workspaceLayoutFor(workspaceId);
  const index = layout.groups.findIndex((group) => group.id === groupId);
  const insertAt = index >= 0 ? index + 1 : layout.groups.length;
  layout.groups.splice(insertAt, 0, { id: crypto.randomUUID(), tabs: [], size: 1 });
  normalizeGroupSizes(layout);
  return replaceWorkspaceGroupsStream(workspaceId);
}

async function removeWorkspaceGroupEndpoint(workspaceId: string, groupId: string): Promise<Response> {
  const layout = await workspaceLayoutFor(workspaceId);
  const index = layout.groups.findIndex((group) => group.id === groupId);
  if (index >= 0 && layout.groups.length > 1 && layout.groups[index]?.tabs.length === 0) layout.groups.splice(index, 1);
  normalizeGroupSizes(layout);
  return replaceWorkspaceGroupsStream(workspaceId);
}

async function closeWorkspaceGroupEndpoint(workspaceId: string, groupId: string): Promise<Response> {
  const layout = await workspaceLayoutFor(workspaceId);
  const index = layout.groups.findIndex((group) => group.id === groupId);
  if (index > 0 && layout.groups.length > 1) {
    const [closed] = layout.groups.splice(index, 1);
    const left = layout.groups[index - 1];
    if (closed && left) {
      left.tabs.push(...closed.tabs.filter((tab) => !left.tabs.includes(tab)));
      left.activeTab = closed.activeTab ?? left.activeTab;
    }
  }
  normalizeGroupSizes(layout);
  return replaceWorkspaceGroupsStream(workspaceId);
}

async function workspaceGroupActionEndpoint(workspaceId: string, groupId: string, actionKey: string): Promise<Response> {
  let createdKey: string | undefined;
  if (actionKey === "agent:create") createdKey = `agent:${(await createNextWorkspaceAgent(workspaceId)).label}`;
  if (actionKey === "terminal:create") createdKey = `terminal:${(await createWorkspaceTerminal(workspaceId)).title}`;
  const { attachments, tabs } = await workspaceTabsAndAttachments(workspaceId);
  const layout = normalizeWorkspaceLayout(workspaceId, tabs);
  const group = layout.groups.find((candidate) => candidate.id === groupId) ?? layout.groups[0];
  if (createdKey && group && !group.tabs.includes(createdKey)) {
    for (const candidate of layout.groups) candidate.tabs = candidate.tabs.filter((tab) => tab !== createdKey);
    group.tabs.push(createdKey);
    group.activeTab = createdKey;
  }
  return turboStreamResponse(`<turbo-stream action="replace" target="${workspaceGroupsId(workspaceId)}"><template>${renderWorkspaceGroups(workspaceId, tabs, attachments)}</template></turbo-stream>`);
}

async function moveWorkspaceTabEndpoint(workspaceId: string, request: Request): Promise<Response> {
  const body = await request.json().catch(() => undefined) as { tab?: unknown; fromGroup?: unknown; toGroup?: unknown; toIndex?: unknown; newGroup?: unknown } | undefined;
  const tab = typeof body?.tab === "string" ? body.tab : "";
  const toGroupId = typeof body?.toGroup === "string" ? body.toGroup : "";
  const layout = await workspaceLayoutFor(workspaceId);
  const source = layout.groups.find((group) => group.tabs.includes(tab));
  let target = layout.groups.find((group) => group.id === toGroupId);
  if (tab && body?.newGroup === true && source) {
    target = { id: crypto.randomUUID(), tabs: [], size: 1 };
    layout.groups.push(target);
  }
  if (tab && target) {
    const wasActive = source?.activeTab === tab;
    if (source) {
      const oldIndex = source.tabs.indexOf(tab);
      source.tabs = source.tabs.filter((key) => key !== tab);
      if (wasActive) source.activeTab = source.tabs[Math.max(0, oldIndex - 1)] ?? source.tabs[0];
    }
    const toIndex = typeof body?.toIndex === "number" && Number.isFinite(body.toIndex) ? Math.max(0, Math.min(body.toIndex, target.tabs.length)) : target.tabs.length;
    target.tabs.splice(toIndex, 0, tab);
    target.activeTab = tab;
    normalizeGroupSizes(layout);
  }
  return replaceWorkspaceGroupsStream(workspaceId);
}

async function resizeWorkspaceGroupsEndpoint(workspaceId: string, request: Request): Promise<Response> {
  const body = await request.json().catch(() => undefined) as { sizes?: unknown } | undefined;
  const sizes = Array.isArray(body?.sizes) ? body.sizes.map(Number).filter((size) => Number.isFinite(size) && size > 0) : [];
  const layout = await workspaceLayoutFor(workspaceId);
  if (sizes.length === layout.groups.length) layout.groups.forEach((group, index) => { group.size = sizes[index] ?? 1; });
  normalizeGroupSizes(layout);
  return jsonResponse({ ok: true });
}

async function updateWorkspaceViewStateEndpoint(id: string, request: Request): Promise<Response> {
  const body = await request.json().catch(() => undefined) as { activeTab?: unknown; groupId?: unknown } | undefined;
  const activeTab = typeof body?.activeTab === "string" ? body.activeTab : undefined;
  const groupId = typeof body?.groupId === "string" ? body.groupId : undefined;
  const group = groupId ? workspaceLayouts.get(id)?.groups.find((candidate) => candidate.id === groupId) : undefined;
  if (activeTab && group?.tabs.includes(activeTab)) group.activeTab = activeTab;
  return jsonResponse({ ok: true });
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
  const selected = formData?.get("selected") === "1";
  try {
    await deleteWorkspace(id, { force });
    workspaceLayouts.delete(id);
    if (wantsTurboStream(request)) {
      if (selected) {
        const workspaces = await listWorkspacesByRecentActivity();
        const nextId = workspaces[0]?.id;
        const nextDetail = nextId ? await workspaceDetailHostHtml(nextId) : renderWorkspaceEmptyDetail();
        const nextUrl = "/";
        return turboStreamResponse(`<turbo-stream action="remove" target="delete-workspace-modal"></turbo-stream><turbo-stream action="replace" target="workspace_sidebar"><template>${await renderWorkspaceSidebar(nextId)}</template></turbo-stream><turbo-stream action="replace" target="workspace_detail"><template>${nextDetail}</template></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="redirect" data-redirect-url-value="${escapeHtml(nextUrl)}" data-redirect-mode-value="replace"></div></template></turbo-stream>`);
      }
      return turboStreamResponse(`<turbo-stream action="remove" target="delete-workspace-modal"></turbo-stream><turbo-stream action="remove" target="${domId("workspace_row", id)}"></turbo-stream><turbo-stream action="append" target="body"><template><div data-controller="remove-workspace-resident" data-remove-workspace-resident-workspace-id-value="${escapeHtml(id)}"></div></template></turbo-stream>`);
    }
    return jsonResponse({ ok: true, result: null });
  } catch (error) {
    const status = error instanceof AtelierCoreError && error.code === "workspace_delete_blocked" ? 409 : 500;
    if (wantsTurboStream(request) && error instanceof AtelierCoreError && error.code === "workspace_delete_blocked") {
      return turboStreamResponse(`<turbo-stream action="remove" target="delete-workspace-modal"></turbo-stream><turbo-stream action="append" target="body"><template>${deleteBlockedModal(id, error.details, { returnTo, selected })}</template></turbo-stream>`);
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
  return response(layout("Error", `<div class="app no-sidebar"><div class="main"><header class="header"><h1>Error</h1></header><div class="body"><p>${escapeHtml(message)}</p><p><a class="btn" href="/">Back home</a></p></div></div></div>`), { status });
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
      if (url.pathname === "/" && request.method === "GET") return await homePage();
      if (url.pathname === "/workspace-events/stream" && request.method === "GET") return await workspaceEventsStream();
      if (url.pathname === "/workspaces" && request.method === "GET") return Response.redirect(new URL("/", url).toString(), 302);
      if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceFromForm(request, url);
      if (url.pathname === "/managed-repos" && request.method === "POST") return await createManagedRepoFromForm(request, url);

      const titleEditMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/sidebar-title\/edit$/);
      if (titleEditMatch && request.method === "GET") return await workspaceSidebarTitleEditFrame(decodeURIComponent(titleEditMatch[1]));

      const titleMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/sidebar-title$/);
      if (titleMatch && request.method === "GET") return await workspaceSidebarTitleShowFrame(decodeURIComponent(titleMatch[1]));
      if (titleMatch && request.method === "POST") return await updateWorkspaceSidebarTitleFromForm(decodeURIComponent(titleMatch[1]), request);

      const viewStateMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/view-state$/);
      if (viewStateMatch && request.method === "POST") return await updateWorkspaceViewStateEndpoint(decodeURIComponent(viewStateMatch[1]), request);

      const groupActionMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/actions\/([^/]+)$/);
      if (groupActionMatch && request.method === "POST") return await workspaceGroupActionEndpoint(decodeURIComponent(groupActionMatch[1]), decodeURIComponent(groupActionMatch[2]), decodeURIComponent(groupActionMatch[3]));

      const groupSplitMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/split$/);
      if (groupSplitMatch && request.method === "POST") return await splitWorkspaceGroupEndpoint(decodeURIComponent(groupSplitMatch[1]), decodeURIComponent(groupSplitMatch[2]));

      const groupRemoveMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/remove$/);
      if (groupRemoveMatch && request.method === "POST") return await removeWorkspaceGroupEndpoint(decodeURIComponent(groupRemoveMatch[1]), decodeURIComponent(groupRemoveMatch[2]));

      const groupCloseMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/groups\/([^/]+)\/close$/);
      if (groupCloseMatch && request.method === "POST") return await closeWorkspaceGroupEndpoint(decodeURIComponent(groupCloseMatch[1]), decodeURIComponent(groupCloseMatch[2]));

      const tabMoveMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/layout\/move-tab$/);
      if (tabMoveMatch && request.method === "POST") return await moveWorkspaceTabEndpoint(decodeURIComponent(tabMoveMatch[1]), request);

      const groupResizeMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/layout\/resize$/);
      if (groupResizeMatch && request.method === "POST") return await resizeWorkspaceGroupsEndpoint(decodeURIComponent(groupResizeMatch[1]), request);

      const healthMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/health$/);
      if (healthMatch && request.method === "GET") return healthPaneEndpoint(decodeURIComponent(healthMatch[1]));

      const healthStreamMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/health\/stream$/);
      if (healthStreamMatch && request.method === "GET") return containerHealthStreamEndpoint(decodeURIComponent(healthStreamMatch[1]));

      const cloneManagedRepoMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/clone-managed-repo$/);
      if (cloneManagedRepoMatch && request.method === "POST") return await cloneManagedRepoIntoWorkspaceFromForm(decodeURIComponent(cloneManagedRepoMatch[1]), request, url);

      const repoPushMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/repos\/([^/]+)\/push$/);
      if (repoPushMatch && request.method === "POST") return await pushRepoEndpoint(decodeURIComponent(repoPushMatch[1]), decodeURIComponent(repoPushMatch[2]), request);

      const workspaceDeleteMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/delete$/);
      if (workspaceDeleteMatch && request.method === "POST") return await deleteWorkspaceEndpoint(decodeURIComponent(workspaceDeleteMatch[1]), url.searchParams.get("force") === "1", request);

      const params = routeParams(url.pathname);
      if (params?.route === "workspace") return await workspacePage(params.id, request);
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
      if (ws.data.kind === "agent") void handleAgentSocketMessage(ws as ServerWebSocket<AgentSocketData>, message, { events: atelierEvents });
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
