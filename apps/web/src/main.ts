import { spawn, type IPty } from "@zenyr/bun-pty";
import type { ServerWebSocket } from "bun";
import {
  AtelierCoreError,
  addManagedRepo,
  createWorkspace,
  createWorkspaceTerminal,
  deleteWorkspace,
  deleteWorkspaceTerminal,
  getWorkspaceRepoMergeability,
  listManagedRepos,
  listWorkspaceTerminals,
  listWorkspaces,
  listWorkspaceRepos,
  setWorkspaceTitle,
  type WorkspaceRepoMergeabilityResult,
} from "@atelier/core";
import { atelierName } from "@atelier/shared";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

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
<script type="module" src="https://cdn.jsdelivr.net/npm/@hotwired/turbo@8.0.13/dist/turbo.es2017-esm.js"></script>
<script type="module" src="/terminal.js"></script>
</head>
<body>${body}
<script>
  document.addEventListener('click', event => {
    const opener = event.target.closest('[data-open-add-managed-repo]');
    if (opener) document.getElementById('add-managed-repo-modal')?.showModal();
  });
  function renderDeleteBlockedModal(workspaceId, details) {
    document.getElementById('delete-workspace-modal')?.remove();
    const issues = details?.issues || [];
    const content = issues.map(issue => '<section class="delete-issue"><h3>' + escapeHtmlClient(issue.repo) + '</h3>' +
      (issue.uncommittedPaths?.length ? '<h4>Uncommitted/staged paths</h4><ul>' + issue.uncommittedPaths.map(path => '<li><code>' + escapeHtmlClient(path) + '</code></li>').join('') + '</ul>' : '') +
      (issue.outgoingCommits?.length ? '<h4>Unpushed commits</h4><ul>' + issue.outgoingCommits.map(commit => '<li><code>' + escapeHtmlClient((commit.hash || '').slice(0, 12)) + '</code> ' + escapeHtmlClient(commit.subject || '') + '</li>').join('') + '</ul>' : '') +
      '</section>').join('');
    document.body.insertAdjacentHTML('beforeend', '<dialog id="delete-workspace-modal" class="modal delete-modal"><form method="dialog"><h2>Workspace has uncommitted changes</h2><p>Deleting this workspace would discard local changes or commits that have not been pushed.</p>' + content + '<div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn danger" value="force" data-force-delete-workspace="' + escapeHtmlClient(workspaceId) + '">Force delete</button></div></form></dialog>');
    document.getElementById('delete-workspace-modal')?.showModal();
  }
  function escapeHtmlClient(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }
  async function deleteWorkspaceClient(workspaceId, force, button) {
    const row = button?.closest('.workspace-row');
    if (button) button.disabled = true;
    const response = await fetch('/workspaces/' + encodeURIComponent(workspaceId) + '/delete' + (force ? '?force=1' : ''), { method: 'POST', headers: { accept: 'text/vnd.turbo-stream.html, application/json' } });
    if (response.ok) {
      const text = await response.text();
      if (text.trim() && window.Turbo?.renderStreamMessage) window.Turbo.renderStreamMessage(text);
      else row?.remove();
      if (!row) location.href = '/workspaces';
      return;
    }
    if (button) button.disabled = false;
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && body?.error?.code === 'workspace_delete_blocked') {
      renderDeleteBlockedModal(workspaceId, body.error.details);
      return;
    }
    alert(body?.error?.message || 'Could not delete workspace.');
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-delete-workspace]');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    deleteWorkspaceClient(button.dataset.deleteWorkspace, false, button);
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-force-delete-workspace]');
    if (!button || button.disabled) return;
    event.preventDefault();
    deleteWorkspaceClient(button.dataset.forceDeleteWorkspace, true, button);
  });
  document.addEventListener('input', event => {
    if (!event.target.matches('.global-filter')) return;
    const q = event.target.value.toLowerCase();
    document.querySelectorAll('.table .row:not(.head)').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
</script>
</body>
</html>`;
}

async function serveStatic(pathname: string): Promise<Response | undefined> {
  const staticFiles: Record<string, { url: URL; contentType: string }> = {
    "/style.css": { url: new URL("../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
    "/terminal.js": { url: new URL("../public/terminal.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
    "/ghostty-vt.wasm": { url: new URL("../public/ghostty-vt.wasm", import.meta.url), contentType: "application/wasm" },
  };
  const entry = staticFiles[pathname];
  if (!entry) return undefined;
  const file = Bun.file(entry.url);
  if (!(await file.exists())) return response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(file, { headers: { "content-type": entry.contentType } });
}

function addManagedRepoModal(): string {
  return `<dialog id="add-managed-repo-modal" class="modal">
  <form method="post" action="/managed-repos">
    <h2>Add managed repository</h2>
    <p>Create a bare clone in Atelier's data directory.</p>
    <input class="modal-input" name="gitUrl" type="url" placeholder="https://github.com/org/repo.git" required autofocus>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn primary" type="submit">Add repository</button>
    </div>
  </form>
</dialog>`;
}

async function workspacesPage(): Promise<Response> {
  const [{ workspaces }, { repos: managedRepos }] = await Promise.all([listWorkspaces(), listManagedRepos()]);
  const rows = workspaces.map((workspace) => {
    const title = workspace.title || `Workspace ${workspace.id}`;
    return `<div class="row workspace-row" id="${domId("workspace_row", workspace.id)}">
      <span class="dot run"></span>
      <a class="row-main" href="/workspaces/${encodeURIComponent(workspace.id)}"><div class="r-title">${escapeHtml(title)}</div><div class="r-sub">${escapeHtml(workspace.id)}</div></a>
      <span class="row-actions"><button class="btn danger sm" type="button" data-delete-workspace="${escapeHtml(workspace.id)}">Delete</button></span>
    </div>`;
  }).join("");

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

  const addManagedRepoRow = `<button class="row ghost-row" type="button" data-open-add-managed-repo>
    <span></span>
    <div><div class="r-title">+ Add managed repository</div><div class="r-sub">Create a bare clone in the Atelier data directory</div></div>
    <span></span>
  </button>`;

  return response(layout("Workspaces", `<div class="app no-sidebar">
  <div class="main">
    <header class="header"><h1>${escapeHtml(atelierName)} · Workspaces</h1></header>
    <div class="body">
      <div class="toolbar">
        <input class="search global-filter" placeholder="Filter workspaces…">
      </div>
      <div class="table">
        <div class="row head"><span></span><span>Workspace</span><span>Actions</span></div>
        ${rows || `<div class="row"><span></span><div><div class="r-title">No workspaces</div><div class="r-sub">Create one below.</div></div><span></span></div>`}
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

async function createWorkspaceFromForm(_request: Request, url: URL): Promise<Response> {
  const created = await createWorkspace();
  return Response.redirect(new URL(`/workspaces/${encodeURIComponent(created.id)}`, url).toString(), 303);
}

async function createManagedRepoFromForm(request: Request, url: URL): Promise<Response> {
  const formData = await request.formData();
  const gitUrl = String(formData.get("gitUrl") ?? "");
  await addManagedRepo(gitUrl);
  return Response.redirect(new URL("/workspaces", url).toString(), 303);
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

function terminalTab(title: string): string {
  return `<button class="tab closable muted" data-tab="terminal:${escapeHtml(title)}" data-terminal-title="${escapeHtml(title)}" type="button">▣ ${escapeHtml(title)} <span class="tab-close" data-close-terminal title="Close terminal">×</span></button>`;
}

function terminalPane(title: string): string {
  return `<section class="tab-pane" data-tab-pane="terminal:${escapeHtml(title)}">
    <div class="terminal-pane" data-terminal-title="${escapeHtml(title)}">
      <div class="terminal-bar">${escapeHtml(title)} · tmux</div>
      <div class="ghostty-terminal" tabindex="0"></div>
    </div>
  </section>`;
}

async function workspacePage(id: string): Promise<Response> {
  const [{ repos }, title, { terminals }] = await Promise.all([listWorkspaceRepos(id), getWorkspaceTitle(id), listWorkspaceTerminals(id)]);
  const terminalTabs = terminals.map((terminal) => terminalTab(terminal.title)).join("");
  const terminalPanes = terminals.map((terminal) => terminalPane(terminal.title)).join("");
  const repoRows = repos.map((repo) => {
    const frameId = domId("repo_mergeability", id, repo);
    return `<turbo-frame id="${frameId}" src="/workspaces/${encodeURIComponent(id)}/repos/${encodeURIComponent(repo)}/mergeability">
      <div class="git-status-row fetching">
        <div class="repo-identity"><span class="repo-dot"></span><b>${escapeHtml(repo)}</b><small>Fetching origin and checking mergeability…</small></div>
        <span class="status-spinner" aria-label="Checking"></span>
      </div>
    </turbo-frame>`;
  }).join("") || `<div class="git-status-row idle"><div class="repo-identity"><span class="repo-dot"></span><b>No repos</b><small>No git repositories found under /workspace.</small></div></div>`;

  return response(layout(title, `<div class="app no-sidebar">
  <div class="main">
    <header class="header workspace-header">
      <div class="workspace-titlebar">
        <span class="crumb"><a href="/workspaces">Workspaces</a> ›</span>
        ${workspaceTitleFrame(id, title)}
      </div>
      <div class="workspace-tabs" id="tabs" data-workspace-id="${escapeHtml(id)}">
        <button class="tab active" data-tab="agent" type="button">◈ Agent</button>
        ${terminalTabs}
        <button class="tab muted" id="add-terminal" type="button">+ Terminal</button>
        <button class="tab muted" data-tab="code" type="button">⌘ Code</button>
        <button class="tab muted" data-tab="commits" type="button">▧ Commits</button>
      </div>
      <div class="header-actions"><button class="btn danger sm" type="button" data-delete-workspace="${escapeHtml(id)}">Delete workspace</button></div>
    </header>

    <div class="body wide workspace-body">
      <div class="workspace-panes">
        <section class="tab-pane active" data-tab-pane="agent">
          <div class="workspace-wide">
            <div class="chat empty-chat">
              <div class="msg agent"><div class="bubble"><p>This workspace is ready. Use + Terminal to open a persistent tmux shell.</p></div></div>
            </div>
            <div class="composer">
              <textarea placeholder="Reply to the agent…" disabled></textarea>
              <div class="row2">
                <span class="dropdown">sonnet-4.5 ▾</span>
                <span class="dropdown">Thinking: Medium ▾</span>
                <span class="spacer"></span>
                <button class="btn primary sm" disabled>Send ↵</button>
              </div>
            </div>
          </div>
        </section>
        ${terminalPanes}
        <section class="tab-pane" data-tab-pane="code"><div class="workspace-wide"><div class="panel"><div class="pad">Code pane will be wired up in a later slice.</div></div></div></section>
        <section class="tab-pane" data-tab-pane="commits"><div class="workspace-wide"><div class="panel"><div class="pad">Commits pane will be wired up in a later slice.</div></div></div></section>
      </div>

      <div class="workspace-footer">
        <div class="agent-tools">
          <form method="post" action="/workspaces"><button class="btn" type="submit">New workspace</button></form>
          <button class="btn" disabled>Review</button>
        </div>

        <section class="git-status-widget" aria-label="Git integration status">
          <div class="git-status-head"><strong>Git status</strong></div>
          ${repoRows}
        </section>
      </div>
    </div>
  </div>
</div>`));
}

function mergeabilityRow(repo: string, result: WorkspaceRepoMergeabilityResult): string {
  const name = escapeHtml(repo);
  switch (result.state) {
    case "can_push":
      return `<div class="git-status-row clean"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b><small>${result.behind} commits behind, no conflicts. ${result.ahead} commits ahead.</small></div><button class="btn primary sm" type="button" disabled>Push</button></div>`;
    case "has_conflicts":
      return `<div class="git-status-row rebase"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b><small>${result.behind} commits behind, ${result.conflictCount} conflicts. ${result.ahead} commits ahead.</small></div><button class="btn sm fix-rebase" type="button" disabled>Ask agent to rebase</button></div>`;
    case "fetch_failed":
      return `<div class="git-status-row fetch-failed"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b><small title="${escapeHtml(result.message)}">Could not fetch upstream. Push status unknown.</small></div><button class="btn sm" type="button" disabled>Retry fetch</button></div>`;
    case "nothing_to_push":
      return `<div class="git-status-row idle"><div class="repo-identity"><span class="repo-dot"></span><b>${name}</b><small>${result.behind} commits behind, nothing to push.</small></div></div>`;
  }
  const exhaustive: never = result;
  return exhaustive;
}

async function mergeabilityFrame(id: string, repo: string): Promise<Response> {
  const frameId = domId("repo_mergeability", id, repo);
  try {
    const result = await getWorkspaceRepoMergeability(id, repo);
    return response(`<turbo-frame id="${frameId}">${mergeabilityRow(repo, result)}</turbo-frame>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return response(`<turbo-frame id="${frameId}"><div class="git-status-row fetch-failed"><div class="repo-identity"><span class="repo-dot"></span><b>${escapeHtml(repo)}</b><small title="${escapeHtml(message)}">Could not check mergeability.</small></div><button class="btn sm" type="button" disabled>Retry fetch</button></div></turbo-frame>`);
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

async function listTerminalsEndpoint(id: string): Promise<Response> {
  return jsonResponse(await listWorkspaceTerminals(id));
}

async function createTerminalEndpoint(id: string): Promise<Response> {
  return jsonResponse(await createWorkspaceTerminal(id), { status: 201 });
}

function errorJsonResponse(error: unknown, status = 500): Response {
  if (error instanceof AtelierCoreError) {
    return jsonResponse({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, { status });
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ ok: false, error: { code: "internal_error", message } }, { status });
}

async function deleteTerminalEndpoint(id: string, title: string): Promise<Response> {
  await deleteWorkspaceTerminal(id, title);
  return jsonResponse(null);
}

async function deleteWorkspaceEndpoint(id: string, force: boolean, request: Request): Promise<Response> {
  try {
    await deleteWorkspace(id, { force });
    if (request.headers.get("accept")?.includes("text/vnd.turbo-stream.html")) {
      return turboStreamResponse(`<turbo-stream action="remove" target="${domId("workspace_row", id)}"></turbo-stream>`);
    }
    return jsonResponse({ ok: true, result: null });
  } catch (error) {
    const status = error instanceof AtelierCoreError && error.code === "workspace_delete_blocked" ? 409 : 500;
    return errorJsonResponse(error, status);
  }
}

interface TerminalSocketData {
  kind: "terminal";
  workspaceId: string;
  title: string;
  cols: number;
  rows: number;
  pty?: IPty;
}

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : fallback;
}

async function validateTerminalSocket(url: URL): Promise<TerminalSocketData | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/terminals\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]);
  const title = decodeURIComponent(match[2]);
  const { terminals } = await listWorkspaceTerminals(workspaceId);
  if (!terminals.some((terminal) => terminal.title === title)) throw new AtelierCoreError("terminal_not_found", `terminal not found: ${title}`);
  return {
    kind: "terminal",
    workspaceId,
    title,
    cols: parsePositiveInteger(url.searchParams.get("cols"), 80),
    rows: parsePositiveInteger(url.searchParams.get("rows"), 24),
  };
}

function openTerminalPty(ws: ServerWebSocket<TerminalSocketData>): void {
  const data = ws.data;
  const args = [
    "exec", "-it",
    "--user", "atelier",
    "--workdir", "/workspace",
    "-e", "TERM=xterm-ghostty",
    "-e", "COLORTERM=truecolor",
    data.workspaceId,
    "tmux", "attach-session", "-t", data.title,
  ];
  try {
    const pty = spawn("docker", args, {
      name: "xterm-ghostty",
      cols: data.cols,
      rows: data.rows,
      env: { ...process.env, TERM: "xterm-ghostty", COLORTERM: "truecolor" },
    });
    data.pty = pty;
    pty.onData((chunk) => {
      setTimeout(() => {
        try {
          ws.send(chunk);
        } catch {
          // Socket closed between PTY output and scheduled send.
        }
      }, 0);
    });
    pty.onExit(() => ws.close());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ws.send(`\r\n\x1b[31m[terminal failed to start: ${message}]\x1b[0m\r\n`);
    ws.close();
  }
}

function handleTerminalSocketMessage(ws: ServerWebSocket<TerminalSocketData>, message: string | Buffer): void {
  const text = typeof message === "string" ? message : message.toString();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "resize") {
      const cols = Number((parsed as { cols?: unknown }).cols);
      const rows = Number((parsed as { rows?: unknown }).rows);
      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) ws.data.pty?.resize(cols, rows);
      return;
    }
  } catch {
    // Raw terminal input is not JSON.
  }
  ws.data.pty?.write(text);
}

function errorPage(error: unknown): Response {
  const status = error instanceof AtelierCoreError && ["workspace_not_found", "repo_not_found", "terminal_not_found"].includes(error.code) ? 404 : 500;
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

Bun.serve<TerminalSocketData>({
  hostname,
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    const staticResponse = await serveStatic(url.pathname);
    if (staticResponse) return staticResponse;

    try {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const socketData = await validateTerminalSocket(url);
        if (!socketData) return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        if (server.upgrade(request, { data: socketData })) return undefined;
        return response("websocket upgrade failed", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/") return Response.redirect(new URL("/workspaces", url).toString(), 302);
      if (url.pathname === "/workspaces" && request.method === "GET") return await workspacesPage();
      if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceFromForm(request, url);
      if (url.pathname === "/managed-repos" && request.method === "POST") return await createManagedRepoFromForm(request, url);

      const titleEditMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/title\/edit$/);
      if (titleEditMatch && request.method === "GET") return await workspaceTitleEditFrame(decodeURIComponent(titleEditMatch[1]));

      const titleMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/title$/);
      if (titleMatch && request.method === "GET") return await workspaceTitleShowFrame(decodeURIComponent(titleMatch[1]));
      if (titleMatch && request.method === "POST") return await updateWorkspaceTitleFromForm(decodeURIComponent(titleMatch[1]), request);

      const terminalsMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/terminals$/);
      if (terminalsMatch && request.method === "GET") return await listTerminalsEndpoint(decodeURIComponent(terminalsMatch[1]));
      if (terminalsMatch && request.method === "POST") return await createTerminalEndpoint(decodeURIComponent(terminalsMatch[1]));

      const terminalDeleteMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/terminals\/([^/]+)\/delete$/);
      if (terminalDeleteMatch && request.method === "POST") return await deleteTerminalEndpoint(decodeURIComponent(terminalDeleteMatch[1]), decodeURIComponent(terminalDeleteMatch[2]));

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
      if (ws.data.kind === "terminal") openTerminalPty(ws);
    },
    message(ws, message) {
      if (ws.data.kind === "terminal") handleTerminalSocketMessage(ws, message);
    },
    close(ws) {
      ws.data.pty?.kill();
    },
  },
});

console.log(`${atelierName} web listening on http://${hostname}:${port}`);
