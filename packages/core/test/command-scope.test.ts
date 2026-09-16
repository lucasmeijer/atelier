import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, withCommandSignal } from "../src/command-scope.ts";
import { createKeyedOperationQueue } from "../src/keyed-operation-queue.ts";

test("cancellation kills and reaps a command and stops its child processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "command-cancel-"));
  try {
    const controller = new AbortController();
    const result = withCommandSignal(controller.signal, () => runCommand(["sh", "-c", `echo $$ > '${dir}/pid'; (sleep 0.2; touch '${dir}/late') & wait`])).catch((error) => error);
    while (!(await Bun.file(join(dir, "pid")).exists())) await Bun.sleep(2);
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    controller.abort(new Error("cancelled"));
    expect(await result).toMatchObject({ message: "cancelled" });
    expect(() => process.kill(pid, 0)).toThrow();
    await Bun.sleep(250);
    expect(await Bun.file(join(dir, "late")).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cancelling a queued operation does not wait for its predecessor or run later", async () => {
  const queue = createKeyedOperationQueue();
  const gate = Promise.withResolvers<void>();
  const first = queue("one", () => gate.promise);
  const controller = new AbortController();
  let ran = false;
  const second = withCommandSignal(controller.signal, () => queue("one", async () => { ran = true; })).catch((error) => error);
  controller.abort(new Error("cancelled"));
  expect(await second).toMatchObject({ message: "cancelled" });
  gate.resolve();
  await first;
  await queue("one", async () => {});
  expect(ran).toBe(false);
});

test("cancelling an acquired queue turn waits for its cleanup before releasing ownership", async () => {
  const queue = createKeyedOperationQueue();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const first = withCommandSignal(controller.signal, () => queue("one", async () => {
    started.resolve();
    try { await runCommand(["sh", "-c", "sleep 60"]); }
    finally { stopped.resolve(); await cleanup.promise; }
  })).catch((error) => error);
  await started.promise;
  let next = false;
  const second = queue("one", async () => { next = true; });
  controller.abort(new Error("cancelled"));
  await stopped.promise;
  expect(next).toBe(false);
  cleanup.resolve();
  expect(await first).toMatchObject({ message: "cancelled" });
  await second;
  expect(next).toBe(true);
});

test("an already-cancelled waiter still observes the shared operation's rejection", async () => {
  const { waitForCommand } = await import("../src/command-scope.ts");
  const signal = AbortSignal.abort(new Error("cancelled"));
  const work = Promise.reject(new Error("shared operation failed"));
  await expect(withCommandSignal(signal, () => waitForCommand(work))).rejects.toThrow("cancelled");
});
