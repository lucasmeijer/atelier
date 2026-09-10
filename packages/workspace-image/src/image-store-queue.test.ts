import { describe, expect, test } from "bun:test";
import { createAtelierEventBus } from "@atelier/core";
import type { WorkspaceProvisionStepEvent } from "../../workspace/src/server/provisioning-web.ts";
import { createDockerImageStoreQueue, workspaceImageStoreWaitReporter, type DockerImageStoreWaitState } from "./image-store-queue.ts";

describe("Docker image store queue", () => {
  test("runs operations in FIFO order", async () => {
    const queue = createDockerImageStoreQueue({ updateIntervalMs: 1 });
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const events: string[] = [];

    const first = queue.run({ label: "first" }, async () => {
      events.push("first:start");
      firstStarted();
      await firstRelease;
      events.push("first:end");
    });
    await started;
    const second = queue.run({ label: "second" }, async () => { events.push("second"); });
    const third = queue.run({ label: "third" }, async () => { events.push("third"); });
    releaseFirst();

    await Promise.all([first, second, third]);
    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
  });

  test("reports what a queued operation is waiting for", async () => {
    const queue = createDockerImageStoreQueue({ updateIntervalMs: 1 });
    let releasePrune!: () => void;
    let pruneStarted!: () => void;
    const pruneRelease = new Promise<void>((resolve) => { releasePrune = resolve; });
    const started = new Promise<void>((resolve) => { pruneStarted = resolve; });
    const waits: DockerImageStoreWaitState[] = [];

    const prune = queue.run({ label: "Pruning old workspace images" }, async () => {
      pruneStarted();
      await pruneRelease;
    });
    await started;
    const build = queue.run({ label: "Building workspace image", onWait: async (state) => { waits.push(state); } }, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 3));
    releasePrune();
    await Promise.all([prune, build]);

    expect(waits[0]).toMatchObject({ status: "waiting", owner: "Pruning old workspace images" });
    expect(waits.at(-1)?.status).toBe("acquired");
  });

  test("continues after an operation fails", async () => {
    const queue = createDockerImageStoreQueue();
    await expect(queue.run({ label: "broken" }, async () => { throw new Error("broken"); })).rejects.toThrow("broken");
    await expect(queue.run({ label: "working" }, async () => "done")).resolves.toBe("done");
  });

  test("does not release a queued turn early when its wait reporter fails", async () => {
    const queue = createDockerImageStoreQueue();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    let thirdStarted = false;

    const first = queue.run({ label: "first" }, async () => {
      firstStarted();
      await firstRelease;
    });
    await started;
    const second = queue.run({ label: "second", onWait: async () => { throw new Error("report failed"); } }, async () => undefined);
    const third = queue.run({ label: "third" }, async () => { thirdStarted = true; });
    await Promise.resolve();
    expect(thirdStarted).toBe(false);

    releaseFirst();
    await first;
    await expect(second).rejects.toThrow("report failed");
    await third;
    expect(thirdStarted).toBe(true);
  });

  test("reports waiting and continuation as workspace provisioning steps", async () => {
    const events = createAtelierEventBus();
    const steps: WorkspaceProvisionStepEvent[] = [];
    events.on("workspace_provision_step", (event) => { steps.push(event); });
    const report = workspaceImageStoreWaitReporter({ events, workspaceId: "workspace-1", parentId: "workspace.image" });

    await report?.({ status: "waiting", owner: "Pruning old repository workspace images", elapsedMs: 1_600 });
    await report?.({ status: "acquired", owner: "Building a repository image", elapsedMs: 2_400 });

    expect(steps).toEqual([
      {
        workspaceId: "workspace-1",
        id: "workspace.image-maintenance",
        label: "Wait for workspace image maintenance",
        parentId: "workspace.image",
        status: "running",
        detail: "Pruning old repository workspace images · 2s elapsed",
      },
      {
        workspaceId: "workspace-1",
        id: "workspace.image-maintenance",
        label: "Wait for workspace image maintenance",
        parentId: "workspace.image",
        status: "done",
        detail: "Continued after 2s",
      },
    ]);
  });
});
