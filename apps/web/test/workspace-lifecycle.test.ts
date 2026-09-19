import { createPiModelRuntime, setConfiguredModels } from "@atelier/llm/server";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addProject, isGitProjectInit } from "@atelier/projects";
import {
  createTestApp,
  deferred,
  post,
  postForm,
  temporaryAtelierDataDir,
  type ProvisionWorkspaceOptions,
} from "./support/test-web-app.ts";

const dataDir = temporaryAtelierDataDir();
beforeEach(dataDir.setUp);
let configuredRuntime = false;
afterEach(async () => {
  if (configuredRuntime) await (await createPiModelRuntime()).removeRuntimeApiKey("openai");
  configuredRuntime = false;
  await dataDir.tearDown();
});

async function configureLaunchModel(): Promise<void> {
  await (await createPiModelRuntime()).setRuntimeApiKey("openai", "test-only-key");
  configuredRuntime = true;
  await setConfiguredModels([{ provider: "openai", id: "gpt-5.4", label: "Test model" }]);
}

describe("workspace lifecycle", () => {
  test("workspace creation returns before provisioning finishes", async () => {
    const provision = deferred();
    const { app, registry } = createTestApp({ provision: () => provision.promise });
    await registry.seed([]);

    const response = await app.fetch(post("/workspaces"));
    const location = response.headers.get("location") ?? "";
    const id = location.match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";

    expect(response.status).toBe(200);
    expect(id).not.toBe("");
    expect(registry.get(id)?.phase.kind).toBe("provisioningPhase");

    provision.resolve();
    while (registry.get(id)?.phase.busy) await Bun.sleep(1);
    expect(registry.get(id)?.phase.kind).toBe("runningPhase");
    expect(registry.get(id)?.requestingAttention).toBe(false);
  });

  test("provisioning waits for explicit confirmation after a recoverable failure", async () => {
    const waiting = deferred();
    let finished = false;
    const { app, registry } = createTestApp({
      provision: async (_id, options) => {
        const step = options.run.step("workspace.setup", "Run project setup", () => { throw new Error("setup failed"); }, "continue");
        waiting.resolve();
        await step;
        finished = true;
      },
    });
    await registry.seed([]);

    const response = await app.fetch(post("/workspaces"));
    const id = (response.headers.get("location") ?? "").match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";
    await waiting.promise;
    await Bun.sleep(0);

    expect(registry.get(id)?.phase.kind).toBe("provisioningPhase");
    expect(finished).toBe(false);

    const retry = await app.fetch(new Request(`http://test.local/workspaces/${id}/provisioning/continue?action=retry`, {
      method: "POST", headers: { accept: "application/json" },
    }));
    expect(retry.status).toBe(400);
    expect(finished).toBe(false);

    const continued = await app.fetch(new Request(`http://test.local/workspaces/${id}/provisioning/continue`, {
      method: "POST",
      headers: { accept: "application/json" },
    }));
    expect(continued.status).toBe(200);
    expect(await continued.json()).toEqual({ continued: true, stepId: "workspace.setup" });
    while (registry.get(id)?.phase.busy) await Bun.sleep(1);
    expect(finished).toBe(true);
    expect(registry.get(id)?.phase.kind).toBe("runningPhase");
    expect(registry.get(id)?.issues).toEqual([{ kind: "readiness", message: "Run project setup: setup failed Continued despite this failure." }]);

    const repeated = await app.fetch(new Request(`http://test.local/workspaces/${id}/provisioning/continue`, {
      method: "POST",
      headers: { accept: "application/json" },
    }));
    expect(repeated.status).toBe(409);
  });

  test("the recovery endpoint uses the executing step's retry policy, not its ID", async () => {
    let attempts = 0;
    const { app, registry } = createTestApp({
      provision: async (_id, { run }) => {
        await run.step("custom.prepare", "Prepare custom runtime", () => {
          if (++attempts === 1) throw new Error("not ready");
        }, "retry-or-continue");
      },
    });
    await registry.seed([]);
    const response = await app.fetch(post("/workspaces"));
    const id = (response.headers.get("location") ?? "").match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";
    await Bun.sleep(0);
    const retry = await app.fetch(new Request(`http://test.local/workspaces/${id}/provisioning/continue?action=retry`, {
      method: "POST", headers: { accept: "application/json" },
    }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ continued: true, stepId: "custom.prepare" });
    while (registry.get(id)?.phase.busy) await Bun.sleep(1);
    expect(attempts).toBe(2);
    expect(registry.get(id)).toMatchObject({ phase: { kind: "runningPhase" } });
    expect(registry.get(id)?.issues).toBeUndefined();
  });

  test("failed provisioning marks the workspace failed and needing attention", async () => {
    const { app, registry } = createTestApp({ provision: async () => { throw new Error("docker exploded"); } });
    await registry.seed([]);

    const response = await app.fetch(post("/workspaces"));
    const id = (response.headers.get("location") ?? "").match(/\/workspaces\/([^/]+)$/)?.[1] ?? "";
    while (registry.get(id)?.phase.busy) await Bun.sleep(1);

    expect(registry.get(id)?.phase).toMatchObject({ status: "failed", busy: false });
    expect(registry.get(id)?.phase.error).toContain("docker exploded");
    expect(registry.get(id)?.requestingAttention).toBe(true);
  });

  test("failed workspaces bypass deletion review", async () => {
    const destroyed: string[] = [];
    const inspected: string[] = [];
    const { app, registry } = createTestApp({
      inspect: async (id) => { inspected.push(id); return ["uncommitted change"]; },
      destroy: async (id) => { destroyed.push(id); },
    });
    await registry.seed([]);
    registry.add("abc", "A");
    registry.setProvisioningState("abc", "failed", "docker exploded");

    const response = await app.fetch(post("/workspaces/abc/delete"));
    while (registry.get("abc")) await Bun.sleep(1);

    expect(response.status).toBe(200);
    expect(inspected).toEqual([]);
    expect(destroyed).toEqual(["abc"]);
  });

  test("project workspace creation records project identity and temporary title", async () => {
    await configureLaunchModel();
    const project = (await addProject("https://github.com/org/sample-project.git")).project;
    const { app, registry } = createTestApp();
    await registry.seed([]);

    const response = await app.fetch(postForm(`/project-agent-workspaces/${encodeURIComponent(project.id)}`, new URLSearchParams({
      text: "do it",
      attachmentDraft: crypto.randomUUID(),
    })));
    const entry = registry.list()[0]!;

    expect(response.status).toBe(200);
    expect(entry.title).toBeNull();
    expect(isGitProjectInit(entry.init)).toBe(true);
    expect(isGitProjectInit(entry.init) && entry.init).toMatchObject({ projectId: project.id, name: "sample-project" });
  });

  test("launch without an available model does not create or provision a workspace", async () => {
    let captured: ProvisionWorkspaceOptions | undefined;
    const { app, registry } = createTestApp({ provision: async (_id, options) => { captured = options; } });
    await registry.seed([{ id: "existing", title: "Existing" }]);
    const attachmentDraft = crypto.randomUUID();

    const response = await app.fetch(postForm("/agent-workspaces", new URLSearchParams({
      text: "Do this when a model is connected",
      model: "openai-codex::gpt-5.6-sol",
      level: "medium",
      attachmentDraft,
    })));

    expect(response.status).toBe(422);
    expect(captured).toBeUndefined();
    expect(registry.list().map((entry) => entry.id)).toEqual(["existing"]);
  });

  test("concurrent duplicate submissions create and provision one workspace", async () => {
    await configureLaunchModel();
    let provisionCount = 0;
    const { app, registry } = createTestApp({ provision: async () => { provisionCount++; } });
    await registry.seed([]);
    const body = new URLSearchParams({ text: "do it once", attachmentDraft: crypto.randomUUID() });

    const [first, retry] = await Promise.all([
      app.fetch(postForm("/agent-workspaces", body)),
      app.fetch(postForm("/agent-workspaces", body)),
    ]);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(registry.list()).toHaveLength(1);
    expect(provisionCount).toBe(1);
  });

  test("blocked deletion waits for explicit user confirmation", async () => {
    let destroyed = false;
    const { app, registry } = createTestApp({
      inspect: async () => ["a.txt", "wip"],
      destroy: async () => { destroyed = true; },
    });
    await registry.seed([{ id: "abc", title: "A" }]);

    const response = await app.fetch(post("/workspaces/abc/delete"));

    expect(response.status).toBe(200);
    expect(registry.get("abc")?.phase.kind).toBe("deletingPhase");
    expect(registry.get("abc")?.phase.deletion).toMatchObject({ status: "blocked" });
    expect(registry.get("abc")?.requestingAttention).toBe(true);
    expect(destroyed).toBe(false);
  });

  test("allowed deletion retains state until destruction completes", async () => {
    const destroy = deferred();
    const { app, registry } = createTestApp({ destroy: () => destroy.promise });
    await registry.seed([{ id: "abc", title: "A" }]);

    const response = await app.fetch(post("/workspaces/abc/delete"));

    expect(response.status).toBe(200);
    expect(registry.get("abc")?.phase.kind).toBe("deletingPhase");
    expect(registry.get("abc")?.phase.deletion).toEqual({ status: "deleting", forced: false });

    destroy.resolve();
    while (registry.get("abc")) await Bun.sleep(1);
    expect(registry.get("abc")).toBeUndefined();
  });

  test("deletion failures remain actionable state", async () => {
    const { app, registry } = createTestApp({ destroy: async () => { throw new Error("docker refused"); } });
    await registry.seed([{ id: "abc", title: "A" }]);

    await app.fetch(post("/workspaces/abc/delete"));
    while (registry.get("abc")?.phase.deletion?.status !== "failed") await Bun.sleep(1);

    expect(registry.get("abc")?.phase).toMatchObject({ kind: "deletingPhase", deletion: { status: "failed" }, busy: false });
    expect(registry.get("abc")?.phase.deletion).toMatchObject({ error: "docker refused" });
    expect(registry.get("abc")?.phase.deletion).toMatchObject({ status: "failed" });
  });

  test("park and unpark persist state and hide parked workspace details", async () => {
    const persisted: Array<{ id: string; parked: boolean }> = [];
    const { app, registry } = createTestApp({
      persistParked: async (id, parked) => { persisted.push({ id, parked }); },
    });
    await registry.seed([{ id: "a", title: "A", parked: false }, { id: "b", title: "B", parked: true }]);

    const parkedPage = await app.fetch(new Request("http://test.local/workspaces/b"));
    expect(parkedPage.status).toBe(302);
    const parkedJson = await (await app.fetch(new Request("http://test.local/workspaces/b", {
      headers: { accept: "application/json" },
    }))).json();
    expect(parkedJson.workspace).not.toHaveProperty("tabs");

    await app.fetch(post("/workspaces/a/park"));
    expect(registry.get("a")?.parked).toBe(true);
    expect(persisted.at(-1)).toEqual({ id: "a", parked: true });

    await app.fetch(post("/workspaces/a/unpark"));
    expect(registry.get("a")?.parked).toBe(false);
    expect(persisted.at(-1)).toEqual({ id: "a", parked: false });

    const fallback = await app.fetch(new Request("http://test.local/workspaces/a/park", {
      method: "POST",
      headers: { referer: "http://test.local/" },
    }));
    expect(fallback.status).toBe(303);
    expect(fallback.headers.get("location")).toBe("http://test.local/");
    expect(registry.get("a")?.parked).toBe(true);
  });

  test("parking requires confirmation and force closes VS Code views while preserving other views", async () => {
    const broadcasts: string[] = [];
    const { app, registry } = createTestApp({ cable: { broadcast: (_topic, html) => { broadcasts.push(html); } } });
    await registry.seed([{ id: "confirm-park", title: "Confirm park", parked: false }]);
    const request = (path: string) => new Request(`http://test.local${path}`, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}",
    });
    await app.fetch(new Request("http://test.local/workspaces/confirm-park", { headers: { accept: "application/json" } }));
    expect((await app.fetch(request("/workspaces/confirm-park/commands/vscode.open"))).status).toBe(200);
    broadcasts.length = 0;
    const blocked = await app.fetch(request("/workspaces/confirm-park/park"));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).workViews).toHaveLength(1);
    expect(registry.get("confirm-park")?.parked).toBe(false);
    expect(broadcasts).toEqual([]);
    expect((await app.fetch(request("/workspaces/confirm-park/park?force=1"))).status).toBe(200);
    expect(registry.get("confirm-park")?.parked).toBe(true);
    await app.fetch(request("/workspaces/confirm-park/unpark"));
    const detail = await (await app.fetch(new Request("http://test.local/workspaces/confirm-park", { headers: { accept: "application/json" } }))).json();
    expect(detail.workspace.workViews.map((view: { reference: { type: string } }) => view.reference.type)).toEqual(["review"]);
  });

});

test("deleting a preparing workspace through JSON cancels its command before destruction", async () => {
  const { runCommand } = await import("@atelier/core");
  const stopped = deferred();
  const destroyed = deferred();
  let laterStep = false;
  let commandStopped = false;
  const { app, registry } = createTestApp({
    provision: async (_id, { run }) => {
      await run.step("slow", "Prepare workspace", async () => {
        try { await runCommand(["sh", "-c", "sleep 60"]); }
        finally { commandStopped = true; stopped.resolve(); }
      });
      laterStep = true;
    },
    destroy: async () => { expect(commandStopped).toBe(true); destroyed.resolve(); },
  });
  const create = await app.fetch(new Request("http://test.local/workspaces", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ source: { type: "empty" } }),
  }));
  const id = (await create.json()).workspace.id;
  expect(registry.get(id)?.phase.kind).toBe("provisioningPhase");
  const response = await app.fetch(new Request(`http://test.local/workspaces/${id}/delete`, {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ force: true }),
  }));
  expect(response.status).toBe(200);
  await stopped.promise;
  await destroyed.promise;
  while (registry.get(id)) await Bun.sleep(1);
  expect(laterStep).toBe(false);
});
