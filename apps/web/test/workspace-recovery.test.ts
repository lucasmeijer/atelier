import { expect, test, spyOn } from "bun:test";
import { recoverWorkspaces } from "../src/server/workspace-recovery.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

test("a broken Docker workspace remains visible as failed without blocking other recovery", async () => {
  const registry = createWorkspaceRegistry();
  const calls: Array<[string, boolean]> = [];
  const error = new Error("invalid mount config for type bind: bind source path does not exist");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await recoverWorkspaces([
      { id: "broken", title: "Stale" },
      { id: "healthy", title: "Healthy" },
      { id: "parked", title: null, parked: true },
    ], registry, async (id, running) => {
      calls.push([id, running]);
      if (id === "broken") throw error;
    });
    expect(calls).toEqual([["broken", true], ["healthy", true], ["parked", false]]);
    expect(registry.get("broken")).toMatchObject({ phase: "failed", title: "Stale", error: `Could not restore workspace: ${error.message}` });
    expect(registry.get("healthy")?.phase).toBe("ready");
    expect(registry.get("parked")).toMatchObject({ phase: "ready", parked: true });
    expect(log).toHaveBeenCalledWith("could not restore workspace broken", error);
    await recoverWorkspaces([{ id: "broken", title: "Stale" }], registry, async () => {});
    expect(registry.get("broken")).toMatchObject({ phase: "ready" });
    expect(registry.get("broken")?.error).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});

test("registry persistence errors still fail startup", async () => {
  const registry = createWorkspaceRegistry({ activityStore: {
    async load() { throw new Error("corrupt activity store"); },
    async save() {},
  } });
  await expect(recoverWorkspaces([], registry, async () => {})).rejects.toThrow("corrupt activity store");
});
