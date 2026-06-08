import {
  AtelierCoreError,
  createWorkspace,
  getWorkspaceRepoMergeability,
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
</head>
<body>${body}
<script>
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
  if (pathname !== "/style.css") return undefined;
  const file = Bun.file(new URL("../public/style.css", import.meta.url));
  if (!(await file.exists())) return response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(file, { headers: { "content-type": "text/css; charset=utf-8" } });
}

async function workspacesPage(): Promise<Response> {
  const { workspaces } = await listWorkspaces();
  const rows = workspaces.map((workspace) => {
    const title = workspace.title || `Workspace ${workspace.id}`;
    return `<a class="row" href="/workspaces/${encodeURIComponent(workspace.id)}">
      <span class="dot run"></span>
      <div><div class="r-title">${escapeHtml(title)}</div><div class="r-sub">${escapeHtml(workspace.id)}</div></div>
      <span class="r-proj">View repos</span>
    </a>`;
  }).join("");

  const newWorkspaceRow = `<form class="contents" method="post" action="/workspaces"><button class="row ghost-row" type="submit">
    <span></span>
    <div><div class="r-title">+ New workspace</div><div class="r-sub">Start a fresh empty workspace</div></div>
    <span class="r-proj">configure later</span>
  </button></form>`;

  return response(layout("Workspaces", `<div class="app no-sidebar">
  <div class="main">
    <header class="header"><h1>${escapeHtml(atelierName)} · Workspaces</h1></header>
    <div class="body">
      <div class="toolbar">
        <input class="search global-filter" placeholder="Filter workspaces…">
      </div>
      <div class="table">
        <div class="row head"><span></span><span>Workspace</span><span></span></div>
        ${rows || `<div class="row"><span></span><div><div class="r-title">No workspaces</div><div class="r-sub">Create one below.</div></div><span></span></div>`}
        ${newWorkspaceRow}
      </div>
    </div>
  </div>
</div>`));
}

async function createWorkspaceFromForm(_request: Request, url: URL): Promise<Response> {
  const created = await createWorkspace();
  return Response.redirect(new URL(`/workspaces/${encodeURIComponent(created.id)}`, url).toString(), 303);
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

async function workspacePage(id: string): Promise<Response> {
  const [{ repos }, title] = await Promise.all([listWorkspaceRepos(id), getWorkspaceTitle(id)]);
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
      <div class="workspace-tabs" id="tabs">
        <button class="tab active" type="button">◈ Agent</button>
        <button class="tab muted" type="button">▣ Terminal</button>
        <button class="tab muted" type="button">⌘ Code</button>
        <button class="tab muted" type="button">▧ Commits</button>
      </div>
    </header>

    <div class="body wide workspace-body">
      <section class="tab-pane active">
        <div class="workspace-wide">
          <div class="chat empty-chat">
            <div class="msg agent"><div class="bubble"><p>This workspace is ready. Agent chat, terminal, code, and commit panes will be wired up in later slices.</p></div></div>
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

function errorPage(error: unknown): Response {
  const status = error instanceof AtelierCoreError && ["workspace_not_found", "repo_not_found"].includes(error.code) ? 404 : 500;
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

Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const staticResponse = await serveStatic(url.pathname);
    if (staticResponse) return staticResponse;

    try {
      if (url.pathname === "/") return Response.redirect(new URL("/workspaces", url).toString(), 302);
      if (url.pathname === "/workspaces" && request.method === "GET") return await workspacesPage();
      if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceFromForm(request, url);

      const titleEditMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/title\/edit$/);
      if (titleEditMatch && request.method === "GET") return await workspaceTitleEditFrame(decodeURIComponent(titleEditMatch[1]));

      const titleMatch = url.pathname.match(/^\/workspaces\/([^/]+)\/title$/);
      if (titleMatch && request.method === "GET") return await workspaceTitleShowFrame(decodeURIComponent(titleMatch[1]));
      if (titleMatch && request.method === "POST") return await updateWorkspaceTitleFromForm(decodeURIComponent(titleMatch[1]), request);

      const params = routeParams(url.pathname);
      if (params?.route === "workspace") return await workspacePage(params.id);
      if (params?.route === "mergeability") return await mergeabilityFrame(params.id, params.repo);

      return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    } catch (error) {
      return errorPage(error);
    }
  },
});

console.log(`${atelierName} web listening on http://${hostname}:${port}`);
