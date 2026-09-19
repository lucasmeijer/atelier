import { expect, test, spyOn } from "bun:test";
import { createWorkspaceProvisioning } from "@atelier/workspace";
import { recoverWorkspaces } from "../src/server/workspace-recovery.ts";
import { createWorkspaceRegistry } from "../src/server/workspace-registry.ts";

const healthy = {
  async setRunning() {}, async checkReadiness() {}, async imageOutdated() { return false; },
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("each workspace remains starting until its own gateway is ready", async () => {
  const registry = createWorkspaceRegistry();
  const provisioning = createWorkspaceProvisioning();
  await registry.seed([{ id: "slow", title: "Slow" }, { id: "healthy", title: "Healthy" }, { id: "parked", title: null, parked: true }]);
  const gateway = Promise.withResolvers<void>();
  const checked: string[] = [];
  const recovery = recoverWorkspaces(registry, { ...healthy, provisioning, async checkReadiness(id) {
    checked.push(id);
    if (id === "slow") await gateway.promise;
  } });
  await tick();
  expect(registry.get("slow")?.phase.kind).toBe("provisioningPhase");
  expect(registry.get("healthy")?.phase.kind).toBe("runningPhase");
  expect(registry.get("parked")).toMatchObject({ parked: true, phase: { kind: "runningPhase" } });
  expect(checked.toSorted()).toEqual(["healthy", "slow"]);
  gateway.resolve();
  await recovery;
  expect(registry.get("slow")?.phase.kind).toBe("runningPhase");
});

test("gateway failure waits for explicit continuation, retaining its warning until successful preparation", async () => {
  const registry = createWorkspaceRegistry();
  const provisioning = createWorkspaceProvisioning();
  await registry.seed([{ id: "slow", title: "Preserved work" }]);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const recovery = recoverWorkspaces(registry, {
      ...healthy, provisioning, async checkReadiness() { throw new Error("gateway unavailable"); },
    });
    await tick();
    expect(registry.get("slow")).toMatchObject({ phase: { kind: "provisioningPhase" }, issues: [{ kind: "readiness" }] });
    expect(provisioning.snapshot("slow")).toMatchObject({ status: "waiting", waiting: { stepId: "workspace.startup", retryable: true } });
    provisioning.resume("slow", "continue");
    await recovery;
    expect(registry.get("slow")).toMatchObject({ phase: { kind: "runningPhase" }, issues: [{ kind: "readiness" }] });
    expect(provisioning.snapshot("slow")?.steps.at(-1)).toMatchObject({ status: "warning", error: "gateway unavailable" });
    await recoverWorkspaces(registry, { ...healthy, provisioning });
    expect(registry.get("slow")?.issues).toBeUndefined();
  } finally { log.mockRestore(); }
});

test("container failure fails only that workspace; image failures remain independent issues", async () => {
  const registry = createWorkspaceRegistry();
  const provisioning = createWorkspaceProvisioning();
  await registry.seed([{ id: "broken", title: null }, { id: "healthy", title: null }]);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await recoverWorkspaces(registry, { ...healthy, provisioning,
      async setRunning(id) { if (id === "broken") throw new Error("missing mount"); },
      async imageOutdated() { throw new Error("invalid image configuration"); },
    });
    expect(registry.get("broken")).toMatchObject({ phase: { kind: "provisioningPhase", status: "failed", error: "missing mount" } });
    expect(registry.get("healthy")).toMatchObject({ phase: { kind: "runningPhase" }, issues: [{ kind: "image" }] });
    expect(provisioning.snapshot("broken")?.steps).toHaveLength(1);
  } finally { log.mockRestore(); }
});

test("deleted workspaces are not revived by a late gateway result", async () => {
  const registry = createWorkspaceRegistry();
  const provisioning = createWorkspaceProvisioning();
  await registry.seed([{ id: "removed", title: null }]);
  const gateway = Promise.withResolvers<void>();
  const recovery = recoverWorkspaces(registry, { ...healthy, provisioning, checkReadiness: () => gateway.promise });
  await tick();
  registry.remove("removed");
  gateway.resolve();
  await recovery;
  expect(registry.get("removed")).toBeUndefined();
});

test("retry repeats only preparation and clears the warning on success", async () => {
  const registry = createWorkspaceRegistry();
  const provisioning = createWorkspaceProvisioning();
  await registry.seed([{ id: "retry", title: "Needs preparation" }, { id: "other", title: "Other" }]);
  let checks = 0;
  let starts = 0;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const recovery = recoverWorkspaces(registry, {
      ...healthy, provisioning,
      async setRunning(id) { if (id === "retry") starts++; },
      async checkReadiness(id) { if (id === "retry" && ++checks < 3) throw new Error("image cache not prepared yet"); },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await tick();
      expect(registry.get("retry")).toMatchObject({ phase: { kind: "provisioningPhase" }, issues: [{ kind: "readiness" }] });
      expect(registry.get("other")?.phase.kind).toBe("runningPhase");
      provisioning.resume("retry", "retry");
    }
    await recovery;
    expect(checks).toBe(3);
    expect(starts).toBe(1);
    expect(registry.get("retry")).toMatchObject({ phase: { kind: "runningPhase" } });
    expect(registry.get("retry")?.issues).toBeUndefined();
    expect(provisioning.snapshot("retry")?.steps.map((step) => [step.id, step.status])).toEqual([
      ["workspace.container", "done"], ["workspace.startup", "done"],
    ]);
  } finally { log.mockRestore(); }
});

test("deletion while waiting releases recovery without another preparation attempt", async () => {
  const registry = createWorkspaceRegistry();
  const provisioning = createWorkspaceProvisioning();
  await registry.seed([{ id: "removed", title: null }]);
  let checks = 0;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const recovery = recoverWorkspaces(registry, {
      ...healthy, provisioning,
      async checkReadiness() { checks++; throw new Error("preparation failed"); },
    });
    await tick();
    registry.remove("removed");
    provisioning.delete("removed");
    await recovery;
    expect(checks).toBe(1);
    expect(registry.get("removed")).toBeUndefined();
    expect(provisioning.snapshot("removed")).toBeUndefined();
  } finally { log.mockRestore(); }
});


test("failure to retain a parked container leaves a non-busy provisioning failure", async () => {
  const registry = createWorkspaceRegistry();
  const provisioning = createWorkspaceProvisioning();
  await registry.seed([{ id: "parked", title: null, parked: true }]);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    await recoverWorkspaces(registry, { ...healthy, provisioning, async setRunning() { throw new Error("Cannot stop container"); } });
    expect(registry.get("parked")).toMatchObject({ parked: false, requestingAttention: true, phase: { kind: "provisioningPhase", status: "failed", busy: false, error: "Cannot stop container" } });
  } finally { log.mockRestore(); }
});
