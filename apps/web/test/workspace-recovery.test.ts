import { expect, test, spyOn } from "bun:test";
import { recoverWorkspaces } from "../src/server/workspace-recovery.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";
import type { WorkspaceProvisionStepEvent } from "@atelier/workspace";

const healthy = {
  async setRunning() {}, async checkGateway() {}, async imageOutdated() { return false; },
  async waitForContinue() { throw new Error("unexpected startup failure"); },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("each workspace remains starting until its own gateway is ready", async () => {
  const registry = createWorkspaceRegistry();
  const workspaces = [{ id: "slow", title: "Slow" }, { id: "healthy", title: "Healthy" }, { id: "parked", title: null, parked: true }];
  await registry.seed(workspaces);
  const gateway = Promise.withResolvers<void>();
  const checked: string[] = [];
  const recovery = recoverWorkspaces(registry, { ...healthy, async checkGateway(id) {
    checked.push(id);
    if (id === "slow") await gateway.promise;
  } });
  await tick();
  expect(registry.get("slow")?.phase).toBe("starting");
  expect(registry.get("healthy")?.phase).toBe("ready");
  expect(registry.get("parked")).toMatchObject({ parked: true, phase: "ready" });
  expect(checked.toSorted()).toEqual(["healthy", "slow"]);
  gateway.resolve();
  await recovery;
  expect(registry.get("slow")?.phase).toBe("ready");
});

test("gateway failure pauses the checklist until explicitly continued, retaining its warning", async () => {
  const registry = createWorkspaceRegistry();
  const workspaces = [{ id: "slow", title: "Preserved work" }];
  await registry.seed(workspaces);
  const gateway = Promise.withResolvers<void>();
  const continuation = Promise.withResolvers<void>();
  const failure = Promise.withResolvers<void>();
  const steps: WorkspaceProvisionStepEvent[] = [];
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const recovery = recoverWorkspaces(registry, {
      ...healthy, checkGateway: () => gateway.promise,
      waitForContinue: (id, stepId) => {
        expect([id, stepId]).toEqual(["slow", "workspace.gateway"]);
        return continuation.promise;
      },
      step(event) { steps.push(event); if (event.awaitingContinue) failure.resolve(); },
    });
    gateway.reject(new Error("Workspace gateway did not become ready within 15 seconds."));
    await failure.promise;
    expect(registry.get("slow")).toMatchObject({ phase: "starting", issues: [{ kind: "gateway" }] });
    expect(steps.at(-1)).toMatchObject({ id: "workspace.gateway", status: "failed", awaitingContinue: true, continueLabel: "Continue without gateway support" });
    continuation.resolve();
    await recovery;
    expect(registry.get("slow")).toMatchObject({ phase: "ready", issues: [{ kind: "gateway" }] });
    expect(steps.at(-1)).toMatchObject({ awaitingContinue: false });
    await recoverWorkspaces(registry, healthy);
    expect(registry.get("slow")?.issues).toBeUndefined();
  } finally { gateway.resolve(); continuation.resolve(); log.mockRestore(); }
});

test("container failure fails only that workspace; image failures remain independent issues", async () => {
  const registry = createWorkspaceRegistry();
  const workspaces = [{ id: "broken", title: null }, { id: "healthy", title: null }];
  await registry.seed(workspaces);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await recoverWorkspaces(registry, { ...healthy,
      async setRunning(id) { if (id === "broken") throw new Error("missing mount"); },
      async imageOutdated() { throw new Error("invalid image configuration"); },
    });
    expect(registry.get("broken")).toMatchObject({ phase: "failed", error: "missing mount" });
    expect(registry.get("healthy")).toMatchObject({ phase: "ready", issues: [{ kind: "image" }] });
  } finally { log.mockRestore(); }
});

test("deleted workspaces are not revived by a late gateway result", async () => {
  const registry = createWorkspaceRegistry();
  const workspaces = [{ id: "removed", title: null }];
  await registry.seed(workspaces);
  const gateway = Promise.withResolvers<void>();
  const recovery = recoverWorkspaces(registry, { ...healthy, checkGateway: () => gateway.promise });
  await tick();
  registry.remove("removed");
  gateway.resolve();
  await recovery;
  expect(registry.get("removed")).toBeUndefined();
});
