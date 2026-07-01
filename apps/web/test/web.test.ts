import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createWebApp } from "../src/server/app.ts";
import { createWorkspaceLayoutStore } from "../src/server/workspace-layout.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { setWorkspaceGitHubToken } from "@atelier/proxy-egress";
import { addProject, getGitIdentity, isGitProjectInit, listProjects, projectWorkspaceInit, type WorkspaceDeleteBlockedDetails } from "@atelier/projects";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ProvisionWorkspace = Parameters<typeof createWebApp>[0]["provisionWorkspace"];
type ProvisionWorkspaceOptions = Parameters<ProvisionWorkspace>[1];

interface TestAppOptions {
  provision?: (id: string, options?: ProvisionWorkspaceOptions) => Promise<void>;
  inspect?: (id: string) => Promise<WorkspaceDeleteBlockedDetails>;
  destroy?: (id: string) => Promise<void>;
  persistParked?: (id: string, parked: boolean) => Promise<void>;
}

function createTestApp(options: TestAppOptions = {}) {
  const registry = createWorkspaceRegistry({
    activityStore: { load: async () => ({}), save: async () => {} },
  });
  const layouts = createWorkspaceLayoutStore();
  const broadcasts: string[] = [];
  const app = createWebApp({
    registry,
    layouts,
    cable: { broadcast: (_identifier, html) => broadcasts.push(html) },
    provisionWorkspace: options.provision ?? (async () => {}),
    provisioningHooks: [],
    inspectDeleteSafety: options.inspect ?? (async (id) => ({ workspaceId: id, issues: [] })),
    destroyWorkspace: options.destroy ?? (async () => {}),
    persistWorkspaceParked: options.persistParked ?? (async () => {}),
    logError: () => {},
  });
  return { app, registry, broadcasts };
}

function post(path: string): Request {
  return new Request(`http://test.local${path}`, { method: "POST", headers: { accept: "text/vnd.turbo-stream.html" } });
}

function postForm(path: string, body: URLSearchParams): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "text/vnd.turbo-stream.html", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withTempDataDir<T>(fn: () => Promise<T>): Promise<T> {
  const previousDataDir = process.env.ATELIER_DATA_DIR;
  const previousGitHubToken = process.env.GH_TOKEN;
  const dataDir = await mkdtemp(join(tmpdir(), "atelier-web-test-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  delete process.env.GH_TOKEN;
  try {
    return await fn();
  } finally {
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await rm(dataDir, { recursive: true, force: true });
  }
}

const blockedDetails = (id: string): WorkspaceDeleteBlockedDetails => ({
  workspaceId: id,
  issues: [{ repo: "demo", uncommittedPaths: ["a.txt"], outgoingCommits: [{ hash: "abc123", subject: "wip" }] }],
});

describe("web app contracts", () => {
  test("HEAD / and /up match their GET status without a body", async () => {
    const { app } = createTestApp();
    const home = await app.fetch(new Request("http://test.local/", { method: "HEAD" }));
    const up = await app.fetch(new Request("http://test.local/up", { method: "HEAD" }));

    expect(home.status).toBe(200);
    expect(await home.text()).toBe("");
    expect(up.status).toBe(200);
    expect(await up.text()).toBe("");
  });

  test("GET /projects/github-search renders GitHub repository options for non-url queries", async () => {
    await withTempDataDir(async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/search/repositories");
        expect(url.searchParams.get("q")).toBe("atelier in:name,description is:public");
        expect(url.searchParams.get("sort")).toBe("stars");
        expect(url.searchParams.get("order")).toBe("desc");
        return Response.json({
          items: [{
            full_name: "org/atelier",
            description: "server-rendered agents",
            private: false,
            clone_url: "https://github.com/org/atelier.git",
            html_url: "https://github.com/org/atelier",
            default_branch: "main",
          }],
        });
      }, originalFetch);
      try {
        const { app } = createTestApp();
        const response = await app.fetch(new Request("http://test.local/projects/github-search?q=atelier"));
        const body = await response.text();

        expect(response.headers.get("content-type")).toContain("text/html");
        expect(body).toContain("org/atelier");
        expect(body).toContain("data-git-url=\"https://github.com/org/atelier.git\"");
        expect(body).not.toContain("public");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("GET /projects/github-search prioritizes private repositories when GitHub is connected", async () => {
    await withTempDataDir(async () => {
      setWorkspaceGitHubToken("github-token");
      const queries: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        queries.push(url.searchParams.get("q") ?? "");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer github-token");
        return Response.json({
          items: url.searchParams.get("q")?.includes("is:private")
            ? [{ full_name: "me/private-atelier", description: "mine", private: true, clone_url: "https://github.com/me/private-atelier.git", html_url: "https://github.com/me/private-atelier", default_branch: "main" }]
            : [{ full_name: "public/atelier", description: "public", private: false, clone_url: "https://github.com/public/atelier.git", html_url: "https://github.com/public/atelier", default_branch: "main" }],
        });
      }, originalFetch);
      try {
        const { app } = createTestApp();
        const response = await app.fetch(new Request("http://test.local/projects/github-search?q=atelier"));
        const body = await response.text();

        expect(queries.toSorted()).toEqual(["atelier in:name,description is:private", "atelier in:name,description is:public"]);
        expect(body.indexOf("me/private-atelier")).toBeLessThan(body.indexOf("public/atelier"));
        expect(body).toContain("🔒");
        expect(body).toContain("Private repository");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("GET /projects/github-search skips URL-like project specs", async () => {
    await withTempDataDir(async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async () => {
        throw new Error("unexpected fetch");
      }, originalFetch);
      try {
        const { app } = createTestApp();
        const response = await app.fetch(new Request("http://test.local/projects/github-search?q=https%3A%2F%2Fgithub.com%2Forg%2Frepo.git"));
        expect(await response.text()).toBe("");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("POST /workspaces responds with streams and Location before provisioning finishes", async () => {
    const provision = deferred();
    const { app, registry, broadcasts } = createTestApp({ provision: () => provision.promise });
    await registry.seed([]);
    broadcasts.length = 0;

    const response = await app.fetch(post("/workspaces"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    const location = response.headers.get("location") ?? "";
    const id = location.match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";
    expect(id).not.toBe("");
    expect(registry.get(id)?.phase).toBe("starting");

    const body = await response.text();
    expect(body).toContain('target="workspaces_table_rows"');
    expect(body).toContain('data-phase="starting"');

    // The broadcast prepends a starting row for everyone (via the rows container).
    const listBroadcast = broadcasts.find((html) => html.includes('target="workspaces_table_rows"'));
    expect(listBroadcast).toBeDefined();
    expect(listBroadcast).toContain('data-phase="starting"');
    // Must be "update" (innerHTML), not "replace": replace would destroy the
    // rows container and break every subsequent list broadcast.
    expect(listBroadcast).toContain('<turbo-stream action="update" target="workspaces_table_rows">');

    broadcasts.length = 0;
    provision.resolve();
    await Bun.sleep(20);
    expect(registry.get(id)?.phase).toBe("ready");
    expect(broadcasts.some((html) => html.includes(`target="workspace_row_${id}"`) && html.includes('data-phase="ready"'))).toBe(true);
  });

  test("failed provisioning marks the workspace failed", async () => {
    const { app, registry } = createTestApp({ provision: async () => { throw new Error("docker exploded"); } });
    await registry.seed([]);

    const response = await app.fetch(post("/workspaces"));
    const id = (response.headers.get("location") ?? "").match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";
    await Bun.sleep(20);

    expect(registry.get(id)?.phase).toBe("failed");
    expect(registry.get(id)?.error).toContain("docker exploded");
  });

  test("failed workspaces can be deleted", async () => {
    const destroyed: string[] = [];
    const inspected: string[] = [];
    const { app, registry, broadcasts } = createTestApp({
      inspect: async (id) => { inspected.push(id); return blockedDetails(id); },
      destroy: async (id) => { destroyed.push(id); },
    });
    await registry.seed([]);
    registry.add("abc", "A");
    registry.setPhase("abc", "failed", "docker exploded");

    const html = await (await app.fetch(new Request("http://test.local/"))).text();
    expect(html).toContain('action="/workspaces/abc/delete"');
    expect(html).toContain('aria-label="Delete workspace"');

    broadcasts.length = 0;
    const response = await app.fetch(post("/workspaces/abc/delete"));

    expect(response.status).toBe(200);
    await Bun.sleep(20);
    expect(inspected).toEqual([]);
    expect(destroyed).toEqual(["abc"]);
    expect(registry.get("abc")).toBeUndefined();
    expect(broadcasts.some((item) => item.includes('<turbo-stream action="remove" target="workspace_row_abc">'))).toBe(true);
  });

  test("POST /api/workspaces creates an empty workspace asynchronously", async () => {
    const provision = deferred();
    const seen: Array<{ id: string; options: unknown }> = [];
    const { app, registry } = createTestApp({ provision: (id, options) => { seen.push({ id, options }); return provision.promise; } });
    await registry.seed([]);

    const response = await app.fetch(postJson("/api/workspaces", {}));
    const body = await response.json() as { workspace: { id: string; url: string; phase: string } };

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("location")).toBe(body.workspace.url);
    expect(body.workspace.phase).toBe("starting");
    expect(registry.get(body.workspace.id)?.phase).toBe("starting");
    expect(registry.get(body.workspace.id)?.init).toBeUndefined();
    expect(seen[0]?.id).toBe(body.workspace.id);

    provision.resolve();
  });

  test("POST /api/workspaces creates a project workspace with an initial prompt", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git#main")).project;
      const seen: Array<{ id: string; options: ProvisionWorkspaceOptions }> = [];
      const { app, registry } = createTestApp({ provision: async (id, options) => { seen.push({ id, options }); } });
      await registry.seed([]);

      const response = await app.fetch(postJson("/api/workspaces", {
        source: { type: "project", project: "sample-project" },
        prompt: "Add tests",
        agent: { model: "openai::gpt", thinkingLevel: "medium" },
      }));
      const body = await response.json() as { workspace: { id: string } };
      const entry = registry.get(body.workspace.id)!;

      expect(response.status).toBe(202);
      expect(isGitProjectInit(entry.init)).toBe(true);
      expect(isGitProjectInit(entry.init) && entry.init.projectId).toBe(project.id);
      expect(isGitProjectInit(entry.init) && entry.init.name).toBe("sample-project");
      expect(isGitProjectInit(entry.init) && entry.init.gitUrl).toBe("https://github.com/org/sample-project.git");
      expect(isGitProjectInit(entry.init) && entry.init.branch).toBe("main");
      expect(seen[0]?.options?.context).toEqual({ agent: { initialPrompt: "Add tests", model: "openai::gpt", thinkingLevel: "medium", attachmentDraft: "" } });
    });
  });

  test("project rows launch from the whole row and expose delete confirmation without a plus icon", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const html = await (await app.fetch(new Request("http://test.local/"))).text();

      expect(html).toContain('class="row project-row repo-tinted-row" role="button"');
      expect(html).toContain(`data-modal-opener-target-id-value="agent_launch_project_modal_${project.id}"`);
      expect(html).not.toContain("repo-launch-icon");
      expect(html).toContain('class="project-row-delete"');
      expect(html).toContain(`id="delete_project_modal_${project.id}"`);
      expect(html).toContain(`action="/projects/${project.id}/delete"`);
      expect(html).not.toContain("This is only allowed when no workspaces reference this project.");
    });
  });

  test("deleting an unreferenced project removes it from the sidebar", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const response = await app.fetch(post(`/projects/${encodeURIComponent(project.id)}/delete`));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect((await listProjects()).projects).toEqual([]);
      expect(body).toContain('target="workspace_sidebar"');
      expect(body).toContain('target="project_launch_modals"');
      expect(body).not.toContain("sample-project");
    });
  });

  test("deleting a referenced project is blocked", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([{ id: "abc", title: "A", init: projectWorkspaceInit(project) }]);

      const response = await app.fetch(post(`/projects/${encodeURIComponent(project.id)}/delete`));
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("Project is in use");
      expect(body).toContain("A");
      expect(body).toContain('target="project_launch_modals"');
      expect(body).toContain(`id="delete_project_modal_${project.id}"`);
      expect(body).not.toContain(`action="remove" target="delete_project_modal_${project.id}"`);
      expect((await listProjects()).projects).toEqual([project]);
    });
  });

  test("forkCurrentWorkspaceFromAgent creates a fork source with required title and agent options", async () => {
    let captured: { id: string; options?: ProvisionWorkspaceOptions } | undefined;
    const { app, registry } = createTestApp({ provision: async (id, options) => { captured = { id, options }; } });
    const init = projectWorkspaceInit({ id: "project-1", name: "demo", gitUrl: "https://example.test/demo.git", branch: "main", sessionShareKey: "share-1" });
    registry.add("source", "Source", init);
    registry.setPhase("source", "ready");

    const result = await app.forkCurrentWorkspaceFromAgent("source", { title: "Forked", initialPrompt: "continue", model: "provider/model", thinkingLevel: "high", attachmentDraft: "draft-1" });

    expect(result.url).toBe(`/workspaces/${result.id}`);
    expect(registry.get(result.id)?.title).toBe("Forked");
    expect(captured?.id).toBe(result.id);
    expect(captured?.options?.init).toEqual(init);
    expect(captured?.options?.fork).toEqual({ sourceWorkspaceId: "source" });
    expect(captured?.options?.context).toEqual({ fork: { sourceWorkspaceId: "source" }, agent: { initialPrompt: "continue", model: "provider/model", thinkingLevel: "high", attachmentDraft: "draft-1" } });
  });

  test("project-created workspaces use the project name as their temporary title", async () => {
    await withTempDataDir(async () => {
      const project = (await addProject("https://github.com/org/sample-project.git")).project;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const response = await app.fetch(postForm(`/project-agent-workspaces/${encodeURIComponent(project.id)}`, new URLSearchParams({ text: "do it" })));
      const body = await response.text();
      const entry = registry.list()[0]!;

      expect(response.status).toBe(200);
      expect(entry.title).toBeNull();
      expect(isGitProjectInit(entry.init)).toBe(true);
      expect(isGitProjectInit(entry.init) && entry.init.projectId).toBe(project.id);
      expect(isGitProjectInit(entry.init) && entry.init.name).toBe("sample-project");
      expect(body).toContain("sample-project");
      expect(body).toContain(`action="replace" target="agent_launch_project_modal_${project.id}"`);
      expect(body).not.toContain("do it");
      expect(body).not.toContain("sample-project.git");
      expect(body).not.toContain(`Workspace ${entry.id}`);
    });
  });

  test("blocked delete returns the confirmation modal to the requester and restores the row", async () => {
    const { app, registry, broadcasts } = createTestApp({ inspect: async (id) => blockedDetails(id) });
    await registry.seed([{ id: "abc", title: "A" }]);
    broadcasts.length = 0;

    const response = await app.fetch(post("/workspaces/abc/delete"));
    const body = await response.text();

    expect(body).toContain('id="delete-workspace-modal"');
    expect(body).toContain('action="append" target="body"');
    expect(body).toContain("/workspaces/abc/delete?force=1");
    expect(registry.get("abc")?.phase).toBe("ready");

    // Other clients saw the pending state come and go via row broadcasts.
    expect(broadcasts.some((html) => html.includes('data-phase="checking_delete"'))).toBe(true);
    expect(broadcasts.some((html) => html.includes('data-phase="ready"'))).toBe(true);
  });

  test("allowed delete walks checking_delete -> deleting -> row removal", async () => {
    const destroy = deferred();
    const { app, registry, broadcasts } = createTestApp({ destroy: () => destroy.promise });
    await registry.seed([{ id: "abc", title: "A" }]);
    broadcasts.length = 0;

    const response = await app.fetch(post("/workspaces/abc/delete"));
    expect(response.status).toBe(200);
    expect(registry.get("abc")?.phase).toBe("deleting");
    expect(broadcasts.some((html) => html.includes('data-phase="deleting"'))).toBe(true);

    destroy.resolve();
    await Bun.sleep(20);
    expect(registry.get("abc")).toBeUndefined();
    expect(broadcasts.some((html) => html.includes('<turbo-stream action="remove" target="workspace_row_abc">'))).toBe(true);
  });

  test("park and unpark toggle workspace rows with zzz icon before the delete button", async () => {
    const parked: Array<{ id: string; parked: boolean }> = [];
    const { app, registry } = createTestApp({ persistParked: async (id, value) => { parked.push({ id, parked: value }); } });
    await registry.seed([{ id: "a", title: "A", parked: false }, { id: "b", title: "B", parked: true }]);

    expect(registry.list().map((entry) => entry.id)).toEqual(["a", "b"]);

    const parkResponse = await app.fetch(post("/workspaces/a/park"));
    const parkBody = await parkResponse.text();
    expect(registry.get("a")?.parked).toBe(true);
    expect(parked.at(-1)).toEqual({ id: "a", parked: true });
    expect(parkBody).toContain("parked");
    expect(parkBody).toContain('aria-label="Unpark workspace"');
    expect(parkBody).toContain("💤");
    expect(parkBody).toContain('data-turbo="true" data-action="turbo:submit-end->workspace-list#parkToggled"');
    expect(parkBody.indexOf('class="workspace-row-park"')).toBeLessThan(parkBody.indexOf('class="workspace-row-delete"'));

    await app.fetch(post("/workspaces/a/unpark"));
    expect(registry.get("a")?.parked).toBe(false);
    expect(parked.at(-1)).toEqual({ id: "a", parked: false });

    const fallback = await app.fetch(new Request("http://test.local/workspaces/a/park", { method: "POST", headers: { referer: "http://test.local/" } }));
    expect(fallback.status).toBe(303);
    expect(fallback.headers.get("location")).toBe("http://test.local/");
    expect(registry.get("a")?.parked).toBe(true);
  });

  test("ready workspace rows include a busy status slot before the park and delete buttons", async () => {
    const { app, registry, broadcasts } = createTestApp();
    await registry.seed([{ id: "abc", title: "A" }]);

    const html = await (await app.fetch(new Request("http://test.local/"))).text();
    expect(html).toContain('id="workspace_status_abc"');
    expect(html.indexOf('id="workspace_status_abc"')).toBeLessThan(html.indexOf('class="workspace-row-delete"'));

    broadcasts.length = 0;
    registry.setTabBusy("abc", "agent:Agent 1", true);
    const busyBroadcast = broadcasts.find((item) => item.includes('target="workspace_status_abc"')) ?? "";
    expect(busyBroadcast).toContain('class="status-spinner sm"');
    expect(busyBroadcast).toContain('Workspace busy');
  });

  test("broadcast HTML never contains per-client state (visible rows, selection inputs)", async () => {
    const provision = deferred();
    const destroy = deferred();
    const { app, registry, broadcasts } = createTestApp({ provision: () => provision.promise, destroy: () => destroy.promise });
    await registry.seed([{ id: "abc", title: "A" }]);

    await app.fetch(post("/workspaces"));
    provision.resolve();
    await Bun.sleep(20);
    await app.fetch(post("/workspaces/abc/delete"));
    destroy.resolve();
    await Bun.sleep(20);
    registry.setTabBusy("abc", "agent:1", true);
    registry.setTitle("abc", "Renamed");

    expect(broadcasts.length).toBeGreaterThan(0);
    for (const html of broadcasts) {
      expect(html).not.toMatch(/class="[^"]*workspace-row[^"]*\bvisible\b/);
      expect(html).not.toMatch(/class="[^"]*workspace-detail-resident[^"]*\bvisible\b/);
      expect(html).not.toContain('name="selected"');
    }
  });

  test("reordering broadcasts keep working after earlier list broadcasts (touch moves a row up)", async () => {
    let clock = 1000;
    const registry = createWorkspaceRegistry({
      activityStore: { load: async () => ({ a: 500, b: 400 }), save: async () => {} },
      now: () => ++clock,
    });
    const broadcasts: string[] = [];
    createWebApp({
      registry,
      layouts: createWorkspaceLayoutStore(),
      cable: { broadcast: (_identifier, html) => broadcasts.push(html) },
      provisionWorkspace: async () => {},
      provisioningHooks: [],
      inspectDeleteSafety: async (id) => ({ workspaceId: id, issues: [] }),
      destroyWorkspace: async () => {},
    });
    await registry.seed([
      { id: "a", title: null },
      { id: "b", title: null },
    ]);
    broadcasts.length = 0;

    registry.touch("b");

    const reorder = broadcasts.find((html) => html.includes('target="workspaces_table_rows"'));
    expect(reorder).toBeDefined();
    expect(reorder).toContain('action="update"');
    // "b" now renders before "a".
    expect(reorder!.indexOf('id="workspace_row_b"')).toBeLessThan(reorder!.indexOf('id="workspace_row_a"'));
  });

  test("moving the last tab out of a group removes the emptied group", () => {
    const layouts = createWorkspaceLayoutStore();
    layouts.normalize("w", ["a", "b"]);
    layouts.splitGroup("w", ["a", "b"], layouts.normalize("w", ["a", "b"]).groups[0]!.id);
    const state = layouts.normalize("w", ["a", "b"]);
    const [left, right] = state.groups;
    expect(left).toBeDefined();
    expect(right).toBeDefined();

    layouts.moveTab("w", ["a", "b"], { tab: "b", toGroup: right!.id });
    layouts.moveTab("w", ["a", "b"], { tab: "a", toGroup: right!.id });

    const after = layouts.normalize("w", ["a", "b"]);
    expect(after.groups).toHaveLength(1);
    expect(after.groups[0]!.id).toBe(right!.id);
    expect(after.groups[0]!.tabs).toEqual(["b", "a"]);
  });

  test("preview group helper keeps browser in the first non-agent group", () => {
    const layouts = createWorkspaceLayoutStore();
    const tabs = ["agent:Agent 1", "browser", "notes"];
    const initial = layouts.normalize("w", tabs);
    layouts.splitGroup("w", tabs, initial.groups[0]!.id);
    const right = layouts.normalize("w", tabs).groups[1]!;
    layouts.moveTab("w", tabs, { tab: "notes", toGroup: right.id });

    const result = layouts.ensureTabInPreviewGroup("w", tabs, "browser");

    const after = layouts.normalize("w", tabs);
    expect(result?.moved).toBe(true);
    expect(result?.createdGroup).toBe(false);
    expect(after.groups.find((group) => group.tabs.includes("browser"))?.id).toBe(right.id);
    expect(right.tabs).not.toContain("agent:Agent 1");
  });

  test("preview group helper creates a non-agent group when required", () => {
    const layouts = createWorkspaceLayoutStore();
    const tabs = ["agent:Agent 1", "browser"];
    layouts.normalize("w", tabs);

    const result = layouts.ensureTabInPreviewGroup("w", tabs, "browser");

    const after = layouts.normalize("w", tabs);
    expect(result?.moved).toBe(true);
    expect(result?.createdGroup).toBe(true);
    expect(after.groups).toHaveLength(2);
    expect(after.groups[1]!.tabs).toEqual(["browser"]);
    expect(after.groups[1]!.visibleTab).toBe("browser");
  });

  test("preview group helper reopens a closed browser tab", () => {
    const layouts = createWorkspaceLayoutStore();
    const tabs = ["agent:Agent 1", "browser"];
    layouts.closeTab("w", tabs, "browser");

    const result = layouts.ensureTabInPreviewGroup("w", tabs, "browser");

    const after = layouts.normalize("w", tabs);
    expect(result?.createdGroup).toBe(true);
    expect(after.closedTabs).not.toContain("browser");
    expect(after.groups.some((group) => group.tabs.includes("browser"))).toBe(true);
  });

  test("GitHub connect flow asks for GitHub CLI token output", async () => {
    const { app } = createTestApp();

    const response = await app.fetch(post("/settings/github/flow"));
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
    expect(body).toContain("GitHub CLI token");
    expect(body).toContain("gh auth login");
    expect(body).toContain("gh auth token");
    expect(body).toContain("Paste output from gh auth token");
    expect(body).not.toContain("personal-access-tokens");
  });

  test("GitHub connect validates and stores pasted GitHub CLI token", async () => {
    await withTempDataDir(async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = ((url: Parameters<typeof fetch>[0]) => {
          if (url === "https://api.github.com/user") return Promise.resolve(Response.json({ login: "octocat", name: "Mona Lisa", email: "octocat@github.com" }));
          if (url === "https://api.github.com/user/emails") return Promise.resolve(Response.json([]));
          throw new Error(`unexpected fetch ${String(url)}`);
        }) as unknown as typeof fetch;
        const { app } = createTestApp();

        const response = await app.fetch(postForm("/settings/github/connect", new URLSearchParams({ token: "cli-token" })));
        const body = await response.text();

        expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
        expect(body).toContain('target="settings_dialog"');
        expect(body).toContain("Connected");
        expect(body).toContain('target="settings_flow_dialog"');
        expect(await getGitIdentity()).toEqual({ name: "Mona Lisa", email: "octocat@github.com" });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("page shell uses cable instead of a workspace EventSource", async () => {
    const { app, registry } = createTestApp();
    await registry.seed([{ id: "abc", title: "A" }]);

    const page = await app.fetch(new Request("http://test.local/"));
    const html = await page.text();
    expect(html).toContain('data-controller="cable-shell"');
    expect(html).not.toContain("turbo-stream-source");
    expect(html).not.toContain("/workspace-events/stream");

    const legacy = await app.fetch(new Request("http://test.local/workspace-events/stream"));
    expect(legacy.status).toBe(404);
  });
});
