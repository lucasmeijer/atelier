import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import { createWorkspaceProvisioning, workspaceSetupProvisioningHook } from "@atelier/workspace";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("workspace provisioning execution", () => {
  test("records only executed steps, in execution order, with operation results and output", async () => {
    const events = createAtelierEventBus();
    const provisioning = createWorkspaceProvisioning({ events });
    const pending = Promise.withResolvers<void>();
    const finished = provisioning.run("one", async (run) => {
      const result = await run.step("image", "Use configured image", () => "configured");
      expect(result).toBe("configured");
      await run.step("preload", "Save preload images", async () => {
        await events.emit("workspace_provision_progress", { workspaceId: "one", detail: "Saving", output: "log" });
        await pending.promise;
        run.report({ output: "saved" });
      });
      await run.step("container", "Start container", () => {});
    });
    await tick();
    expect(provisioning.snapshot("one")?.steps).toEqual([
      { id: "image", label: "Use configured image", status: "done" },
      { id: "preload", label: "Save preload images", status: "running", detail: "Saving", output: "log" },
    ]);
    pending.resolve();
    await finished;
    expect(provisioning.snapshot("one")).toMatchObject({ status: "done", steps: [
      { id: "image", status: "done" }, { id: "preload", status: "done", output: "saved" }, { id: "container", status: "done" },
    ] });
  });

  test("retry stays in the same row, clears stale output, and cannot be submitted twice", async () => {
    const provisioning = createWorkspaceProvisioning();
    let attempts = 0;
    const finished = provisioning.run("one", async (run) => {
      await run.step("prepare", "Prepare", () => {
        if (++attempts === 1) {
          run.report({ output: "failed attempt", terminalSession: "old" });
          throw new Error("not ready");
        }
      }, "retry-or-continue");
    });
    await tick();
    expect(provisioning.snapshot("one")).toMatchObject({ status: "waiting", waiting: { stepId: "prepare", retryable: true } });
    expect(provisioning.resume("one", "retry")).toBe("prepare");
    expect(() => provisioning.resume("one", "retry")).toThrow("not waiting");
    await finished;
    expect(attempts).toBe(2);
    expect(provisioning.snapshot("one")?.steps).toEqual([{ id: "prepare", label: "Prepare", status: "done" }]);
  });

  test("continuing retains the warning and permits subsequent work, but not unsupported retry", async () => {
    const provisioning = createWorkspaceProvisioning();
    let next = false;
    const finished = provisioning.run("one", async (run) => {
      await run.step("setup", "Setup", () => { throw new Error("setup failed"); }, "continue");
      await run.step("next", "Next", () => { next = true; });
    });
    await tick();
    expect(next).toBe(false);
    provisioning.snapshot("one")!.waiting!.retryable = true;
    expect(() => provisioning.resume("one", "retry")).toThrow("does not support retry");
    provisioning.resume("one", "continue");
    await finished;
    expect(next).toBe(true);
    expect(provisioning.snapshot("one")).toMatchObject({ status: "done", steps: [
      { id: "setup", status: "warning", error: "setup failed" }, { id: "next", status: "done" },
    ] });
  });

  test("required failures abort without synthetic steps", async () => {
    const provisioning = createWorkspaceProvisioning();
    let next = false;
    await expect(provisioning.run("one", async (run) => {
      await run.step("required", "Required", () => { throw new Error("failure"); });
      next = true;
    })).rejects.toThrow("failure");
    expect(next).toBe(false);
    expect(provisioning.snapshot("one")).toMatchObject({ status: "failed", error: "failure", steps: [{ id: "required", status: "failed" }] });
    expect(provisioning.snapshot("one")?.steps).toHaveLength(1);
  });

  test("deleting a waiting run releases it without running subsequent work", async () => {
    const provisioning = createWorkspaceProvisioning();
    let next = false;
    const finished = provisioning.run("one", async (run) => {
      await run.step("prepare", "Prepare", () => { throw new Error("not ready"); }, "retry-or-continue");
      next = true;
    });
    const rejected = finished.catch((error: Error) => error);
    await tick();
    provisioning.delete("one");
    expect(await rejected).toMatchObject({ message: "workspace one provisioning cancelled" });
    expect(next).toBe(false);
    expect(provisioning.snapshot("one")).toBeUndefined();
  });

  test("workspaces progress independently and snapshots cannot mutate execution state", async () => {
    const events = createAtelierEventBus();
    const provisioning = createWorkspaceProvisioning({ events });
    const pending = Promise.withResolvers<void>();
    const first = provisioning.run("one", (run) => run.step("slow", "Slow", () => pending.promise));
    await expect(provisioning.run("one", async () => {})).rejects.toThrow("already has an active");
    await provisioning.run("two", (run) => run.step("fast", "Fast", async () => {
      await events.emit("workspace_provision_progress", { workspaceId: "two", detail: "Only two" });
    }));
    const snapshot = provisioning.snapshot("one")!;
    snapshot.steps[0]!.label = "Changed";
    expect(provisioning.snapshot("one")?.steps[0]).toMatchObject({ label: "Slow", status: "running" });
    expect(provisioning.snapshot("one")?.steps[0]?.detail).toBeUndefined();
    pending.resolve();
    await first;
    await provisioning.run("one", (run) => run.step("resume", "Resume", () => {}));
    expect(provisioning.snapshot("one")?.steps.map((step) => step.id)).toEqual(["resume"]);
  });

  test("recovery can be answered immediately by a change subscriber", async () => {
    const provisioning = createWorkspaceProvisioning({ onChange(id) {
      if (provisioning.snapshot(id)?.waiting) provisioning.resume(id, "continue");
    } });
    await provisioning.run("one", (run) => run.step("setup", "Setup", () => { throw new Error("setup failed"); }, "continue"));
    expect(provisioning.snapshot("one")).toMatchObject({ status: "done", steps: [{ id: "setup", status: "warning" }] });
    expect(provisioning.snapshot("one")?.waiting).toBeUndefined();
  });

  test("a deleted run cannot continue after its in-flight operation finishes", async () => {
    const events = createAtelierEventBus();
    const provisioning = createWorkspaceProvisioning({ events });
    const gate = Promise.withResolvers<void>();
    let next = false;
    const finished = provisioning.run("one", async (run) => {
      await run.step("slow", "Slow", () => gate.promise);
      next = true;
    }).catch((error: Error) => error);
    provisioning.delete("one");
    gate.resolve();
    expect(await finished).toMatchObject({ message: "workspace one provisioning cancelled" });
    expect(next).toBe(false);
    expect(provisioning.snapshot("one")).toBeUndefined();
    // Finished runs no longer subscribe to operation progress.
    await events.emit("workspace_provision_progress", { workspaceId: "one", output: "late output" });
  });

  test("project setup permits explicit continuation, not automatic retry", () => {
    expect(workspaceSetupProvisioningHook.recovery).toBe("continue");
  });
});
