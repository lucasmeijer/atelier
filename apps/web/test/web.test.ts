import { describe, expect, test } from "bun:test";
import { createWebApp } from "../src/server/app.ts";
import { createStreamHub } from "../src/server/stream-hub.ts";
import { createWorkspaceLayoutStore } from "../src/server/workspace-layout.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import type { WorkspaceDeleteBlockedDetails } from "@atelier/core";

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
    inspectDeleteSafety: options.inspect ?? (async (id) => ({ workspaceId: id, issues: [] })),
    destroyWorkspace: options.destroy ?? (async () => {}),
  });
  hub.subscribe((html) => broadcasts.push(html));
  return { app, registry, hub, broadcasts };
}

function post(path: string): Request {
  return new Request(`http://test.local${path}`, { method: "POST", headers: { accept: "text/vnd.turbo-stream.html" } });
}

const blockedDetails = (id: string): WorkspaceDeleteBlockedDetails => ({
  workspaceId: id,
  issues: [{ repo: "demo", uncommittedPaths: ["a.txt"], outgoingCommits: [{ hash: "abc123", subject: "wip" }] }],
});

describe("web app contracts", () => {
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
