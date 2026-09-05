import { describe, expect, test } from "bun:test";
import type { WorkspaceDeletionAssessment } from "@atelier/shared";
import { createWorkspaceDeletion } from "../src/server/workspace-deletion.ts";
import { createWorkspaceRegistry, type WorkspaceDeletionState } from "../src/server/workspace-registry.ts";

const blocked = (fingerprint: string): WorkspaceDeletionAssessment => ({ status: "blocked", fingerprint, details: { file: fingerprint } });

async function setup(options: {
  inspect?: () => Promise<WorkspaceDeletionAssessment>;
  destroy?: (id: string) => Promise<void>;
  persisted?: Record<string, WorkspaceDeletionState>;
  changed?: (state: WorkspaceDeletionState) => void | Promise<void>;
} = {}) {
  const registry = createWorkspaceRegistry({
    deletionStore: { load: async () => options.persisted ?? {}, save: async () => {} },
  });
  await registry.seed([{ id: "workspace", title: "Workspace" }]);
  const states: WorkspaceDeletionState[] = [];
  const destroyed: string[] = [];
  const failed = Promise.withResolvers<void>();
  const removed = Promise.withResolvers<void>();
  const blockedState = Promise.withResolvers<void>();
  registry.setCallbacks({ removed: () => removed.resolve() });
  const deletion = createWorkspaceDeletion({
    registry,
    inspect: options.inspect ?? (async () => ({ status: "clear" })),
    destroy: options.destroy ?? (async (id) => { destroyed.push(id); }),
    changed: (_id, state) => {
      states.push(state);
      if (state.status === "failed") failed.resolve();
      if (state.status === "blocked") blockedState.resolve();
      return options.changed?.(state);
    },
  });
  return { registry, deletion, states, destroyed, failed: failed.promise, removed: removed.promise, blocked: blockedState.promise };
}

describe("workspace deletion", () => {
  test("destruction waits for state notification while exposing deleting immediately", async () => {
    const notified = Promise.withResolvers<void>();
    const { registry, deletion, destroyed, removed } = await setup({
      changed: (state) => state.status === "deleting" ? notified.promise : undefined,
    });
    await deletion.request("workspace", { force: true });
    expect(registry.get("workspace")?.deletion).toEqual({ status: "deleting", forced: true });
    expect(destroyed).toEqual([]);
    notified.resolve();
    await removed;
    expect(destroyed).toEqual(["workspace"]);
  });

  test("confirmation reinspects evidence and requires consent to its current fingerprint", async () => {
    let assessment = blocked("first");
    let inspections = 0;
    const { registry, deletion, destroyed } = await setup({ inspect: async () => { inspections++; return assessment; } });
    expect(await deletion.request("workspace")).toEqual({ deleted: false, blocked: true, details: { file: "first" } });
    expect(registry.hasAttention("workspace")).toBe(true);
    await deletion.request("workspace");
    expect(inspections).toBe(1);
    await expect(deletion.request("workspace", { fingerprint: "stale" })).rejects.toThrow("no longer current");
    expect(inspections).toBe(1);

    assessment = blocked("second");
    expect(await deletion.request("workspace", { fingerprint: "first" })).toEqual({ deleted: false, blocked: true, details: { file: "second" } });
    expect(destroyed).toEqual([]);
    expect(deletion.evidence("workspace")).toEqual({ file: "second" });
    expect(await deletion.request("workspace", { fingerprint: "second" })).toEqual({ deleted: true, blocked: false });
    expect(destroyed).toEqual(["workspace"]);
    expect(registry.get("workspace")).toBeUndefined();
    expect(deletion.evidence("workspace")).toBeUndefined();
  });

  test("confirmation of evidence that became clear deletes without forcing", async () => {
    let assessment = blocked("first");
    const { deletion, states } = await setup({ inspect: async () => assessment });
    await deletion.request("workspace");
    assessment = { status: "clear" };
    await deletion.request("workspace", { fingerprint: "first" });
    expect(states.at(-1)).toEqual({ status: "deleting", forced: false });
  });

  test("checking failures retry inspection and cancellation clears evidence and attention", async () => {
    let fail = true;
    const { registry, deletion, states } = await setup({ inspect: async () => {
      if (fail) throw new Error("cannot inspect");
      return blocked("current");
    } });
    expect(await deletion.request("workspace")).toEqual({ deleted: false, blocked: false });
    expect(states.at(-1)).toEqual({ status: "failed", operation: "checking", error: "cannot inspect" });
    fail = false;
    await deletion.request("workspace");
    expect(deletion.cancel("workspace")).toBe(true);
    expect(registry.get("workspace")?.phase).toBe("ready");
    expect(registry.hasAttention("workspace")).toBe(false);
    expect(deletion.evidence("workspace")).toBeUndefined();
    expect(deletion.cancel("workspace")).toBe(false);
  });

  test("destruction retries preserve the prior forced decision without another inspection", async () => {
    let attempts = 0;
    let inspections = 0;
    const { registry, deletion, states, failed, removed } = await setup({
      inspect: async () => { inspections++; return blocked("current"); },
      destroy: async () => { if (++attempts === 1) throw new Error("docker refused"); },
    });
    await deletion.request("workspace", { force: true });
    await failed;
    expect(registry.get("workspace")?.deletion).toEqual({ status: "failed", operation: "deleting", forced: true, error: "docker refused" });
    await deletion.request("workspace");
    await removed;
    expect(inspections).toBe(0);
    expect(states.at(-1)).toEqual({ status: "deleting", forced: true });
    expect(registry.get("workspace")).toBeUndefined();
  });

  test("restart resumes interrupted deletion and reinspects persisted blocked evidence", async () => {
    const first = await setup({ persisted: { workspace: { status: "deleting", forced: true } } });
    first.deletion.resume();
    await first.removed;
    expect(first.destroyed).toEqual(["workspace"]);
    expect(first.states).toEqual([{ status: "deleting", forced: true }]);

    const second = await setup({
      persisted: { workspace: { status: "blocked", fingerprint: "old" } },
      inspect: async () => blocked("new"),
    });
    second.deletion.resume();
    await second.blocked;
    expect(second.registry.get("workspace")?.deletion).toEqual({ status: "blocked", fingerprint: "new" });
    expect(second.deletion.evidence("workspace")).toEqual({ file: "new" });
  });

  test("bulk destruction awaits each outcome and retains failures for retry", async () => {
    const { registry, deletion } = await setup({ destroy: async (id) => {
      if (id === "workspace") throw new Error("busy");
    } });
    registry.add("second");
    const result = await deletion.destroyAll(["workspace", "second"]);
    expect(result).toEqual({ deleted: 1, errors: ["workspace: busy"] });
    expect(registry.get("workspace")?.deletion).toEqual({ status: "failed", operation: "deleting", forced: true, error: "busy" });
    expect(registry.get("second")).toBeUndefined();
  });
});
