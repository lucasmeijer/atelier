import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createWebApp } from "../src/server/app.ts";
import { createStreamHub } from "../src/server/stream-hub.ts";
import { createWorkspaceLayoutStore } from "../src/server/workspace-layout.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import { clearWorkspaceGitHubToken } from "@atelier/core";
import { addRepository, type WorkspaceDeleteBlockedDetails } from "@atelier/repository";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface TestAppOptions {
  provision?: (id: string) => Promise<void>;
  inspect?: (id: string) => Promise<WorkspaceDeleteBlockedDetails>;
  destroy?: (id: string) => Promise<void>;
  persistParked?: (id: string, parked: boolean) => Promise<void>;
}

function createTestApp(options: TestAppOptions = {}) {
  const registry = createWorkspaceRegistry({
    activityStore: { load: async () => ({}), save: async () => {} },
  });
  const hub = createStreamHub();
  const layouts = createWorkspaceLayoutStore();
  const broadcasts: string[] = [];
  const app = createWebApp({
    registry,
    hub,
    layouts,
    provisionWorkspace: options.provision ?? (async () => {}),
    provisioningHooks: [],
    inspectDeleteSafety: options.inspect ?? (async (id) => ({ workspaceId: id, issues: [] })),
    destroyWorkspace: options.destroy ?? (async () => {}),
    persistWorkspaceParked: options.persistParked ?? (async () => {}),
    logError: () => {},
  });
  hub.subscribe((html) => broadcasts.push(html));
  return { app, registry, hub, broadcasts };
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

  test("repo-created workspaces use the repository name as their temporary title", async () => {
    const previousDataDir = process.env.ATELIER_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-web-test-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    try {
      const repo = (await addRepository("https://github.com/org/sample-project.git")).repo;
      const { app, registry } = createTestApp();
      await registry.seed([]);

      const response = await app.fetch(postForm(`/repo-agent-workspaces/${encodeURIComponent(repo.id)}`, new URLSearchParams({ text: "do it" })));
      const body = await response.text();
      const entry = registry.list()[0]!;

      expect(response.status).toBe(200);
      expect(entry.title).toBeNull();
      expect(entry.sourceRepositoryId).toBe(repo.id);
      expect(entry.sourceRepositoryName).toBe("sample-project");
      expect(body).toContain("sample-project");
      expect(body).not.toContain("sample-project.git");
      expect(body).not.toContain(`Workspace ${entry.id}`);
    } finally {
      if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
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

  test("broadcast HTML never contains per-client state (active rows, selection inputs)", async () => {
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
      expect(html).not.toMatch(/class="[^"]*workspace-row[^"]*\bactive\b/);
      expect(html).not.toMatch(/class="[^"]*workspace-detail-resident[^"]*\bactive\b/);
      expect(html).not.toContain('name="selected"');
    }
  });

  test("reordering broadcasts keep working after earlier list broadcasts (touch moves a row up)", async () => {
    let clock = 1000;
    const registry = createWorkspaceRegistry({
      activityStore: { load: async () => ({ a: 500, b: 400 }), save: async () => {} },
      now: () => ++clock,
    });
    const hub = createStreamHub();
    const broadcasts: string[] = [];
    createWebApp({
      registry,
      hub,
      layouts: createWorkspaceLayoutStore(),
      provisionWorkspace: async () => {},
      provisioningHooks: [],
      inspectDeleteSafety: async (id) => ({ workspaceId: id, issues: [] }),
      destroyWorkspace: async () => {},
    });
    hub.subscribe((html) => broadcasts.push(html));
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

  test("preview browser layout helper keeps browser in an agent-free group", () => {
    const layouts = createWorkspaceLayoutStore();
    const tabs = ["agent:Agent 1", "browser", "notes"];
    const initial = layouts.normalize("w", tabs);
    layouts.splitGroup("w", tabs, initial.groups[0]!.id);
    const right = layouts.normalize("w", tabs).groups[1]!;
    layouts.moveTab("w", tabs, { tab: "notes", toGroup: right.id });

    const result = layouts.ensureTabInAgentFreeGroup("w", tabs, "browser");

    const after = layouts.normalize("w", tabs);
    expect(result?.moved).toBe(true);
    expect(result?.createdGroup).toBe(false);
    expect(after.groups.find((group) => group.tabs.includes("browser"))?.id).toBe(right.id);
    expect(right.tabs).not.toContain("agent:Agent 1");
  });

  test("preview browser layout helper creates an agent-free group when required", () => {
    const layouts = createWorkspaceLayoutStore();
    const tabs = ["agent:Agent 1", "browser"];
    layouts.normalize("w", tabs);

    const result = layouts.ensureTabInAgentFreeGroup("w", tabs, "browser");

    const after = layouts.normalize("w", tabs);
    expect(result?.moved).toBe(true);
    expect(result?.createdGroup).toBe(true);
    expect(after.groups).toHaveLength(2);
    expect(after.groups[1]!.tabs).toEqual(["browser"]);
    expect(after.groups[1]!.activeTab).toBe("browser");
  });

  test("preview browser layout helper reopens a closed browser tab", () => {
    const layouts = createWorkspaceLayoutStore();
    const tabs = ["agent:Agent 1", "browser"];
    layouts.closeTab("w", tabs, "browser");

    const result = layouts.ensureTabInAgentFreeGroup("w", tabs, "browser");

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
    const previousDataDir = process.env.ATELIER_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), "atelier-web-github-"));
    const originalFetch = globalThis.fetch;
    try {
      process.env.ATELIER_DATA_DIR = dataDir;
      globalThis.fetch = (() => Promise.resolve(Response.json({ login: "octocat" }))) as unknown as typeof fetch;
      const { app } = createTestApp();

      const response = await app.fetch(postForm("/settings/github/connect", new URLSearchParams({ token: "cli-token" })));
      const body = await response.text();

      expect(response.headers.get("content-type")).toContain("text/vnd.turbo-stream.html");
      expect(body).toContain('target="settings_dialog"');
      expect(body).toContain("Connected");
      expect(body).toContain('target="settings_flow_dialog"');
    } finally {
      clearWorkspaceGitHubToken();
      globalThis.fetch = originalFetch;
      if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("SSE stream emits raw turbo-stream HTML in plain data: lines (turbo-stream-source compatible)", async () => {
    const { app, registry, hub } = createTestApp();
    await registry.seed([{ id: "abc", title: "A" }]);

    const response = await app.fetch(new Request("http://test.local/workspace-events/stream"));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // Initial status catch-up arrives as raw turbo-stream HTML, not JSON.
    const first = decoder.decode((await reader.read()).value);
    expect(first.startsWith("data: <turbo-stream")).toBe(true);
    expect(first).not.toContain('data: "');

    hub.broadcast(`<turbo-stream action="replace" target="x"><template>line1\nline2</template></turbo-stream>`);
    const second = decoder.decode((await reader.read()).value);
    expect(second.split("\n").filter(Boolean).every((line) => line.startsWith("data: "))).toBe(true);
    expect(second).toContain("data: line2");

    await reader.cancel();
  });
});
