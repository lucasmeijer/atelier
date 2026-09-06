import { describe, expect, test } from "bun:test";
import { SubagentRuntime, type SubagentMessage, type SubagentState } from "../../src/server/subagent-runtime.ts";

function harness() {
  const deliveries: Array<{ id: string; message: SubagentMessage; triggerTurn: boolean }> = [];
  const aborted: string[] = [];
  const snapshots: SubagentState[] = [];
  let failure = false;
  const runtime = new SubagentRuntime({ agents: [], messages: [] }, {
    async save(state) { snapshots.push(state); },
    async peer(id) {
      return {
        model: () => ({ provider: "test", id: "inherited" }), thinkingLevel: () => "high",
        async send(message, triggerTurn) {
          if (failure) throw new Error("provider unavailable");
          deliveries.push({ id, message, triggerTurn });
          await runtime.delivered(message.id);
        },
        async abort() { aborted.push(id); },
      };
    },
  });
  return { runtime, deliveries, aborted, snapshots, fail: () => { failure = true; } };
}

describe("subagent delegation protocol", () => {
  test("spawns with inherited settings and an attributable plaintext task", async () => {
    const { runtime, deliveries, snapshots } = harness();
    const child = await runtime.spawn("parent", "review", "Read <source> & return findings");
    expect(child).toMatchObject({ parentId: "parent", rootId: "parent", depth: 1, model: { provider: "test", id: "inherited" }, thinkingLevel: "high" });
    expect(deliveries[0]).toMatchObject({ id: child.id, triggerTurn: true, message: { from: "parent", to: child.id, kind: "task", text: "Read <source> & return findings" } });
    expect(snapshots.at(-1)!.messages[0].delivery).toBe("delivered");
    expect(snapshots[0].messages).toEqual([]);
  });

  test("task receipts retain their originating tool call without changing message text", async () => {
    const { runtime, deliveries } = harness();
    const child = await runtime.spawn("parent", "trace", "Initial task", undefined, "none", "spawn-call");
    await runtime.followup("parent", child.id, "Next task", "followup-call");
    expect(deliveries[0].message).toMatchObject({ toolCallId: "spawn-call", text: "Initial task", kind: "task" });
    expect(deliveries[1].message).toMatchObject({ toolCallId: "followup-call", text: "Next task", kind: "task" });
    expect(runtime.state.messages.map((message) => message.toolCallId)).toEqual(["spawn-call", "followup-call"]);
  });

  test("messages do not trigger turns; follow-up tasks do", async () => {
    const { runtime, deliveries } = harness();
    const child = await runtime.spawn("parent", "review", "Review");
    await runtime.send("parent", child.id, "Additional context");
    await runtime.send(child.id, "/root", "Question?");
    await runtime.followup("parent", "review", "Check again");
    expect(deliveries.map((delivery) => delivery.triggerTurn)).toEqual([true, false, false, true]);
    expect(deliveries[2].message.to).toBe("parent");
  });

  test("completion automatically flows to parent and wakes a waiting tool", async () => {
    const { runtime, deliveries } = harness();
    const child = await runtime.spawn("parent", "review", "Review");
    await runtime.started(child.id);
    const waiting = runtime.wait("parent", 1000);
    await runtime.finished(child.id, "Found two bugs", "completed");
    const result = await waiting;
    expect(result.timed_out).toBe(false);
    expect(result.messages).toMatchObject([{ from: child.id, to: "parent", kind: "completion", text: "Found two bugs" }]);
    expect(deliveries.at(-1)!.triggerTurn).toBe(false);
    expect(result.agents[0]).toMatchObject({ status: "completed", result: "Found two bugs" });
    expect((await runtime.wait("parent", 1)).timed_out).toBe(true);
  });

  test("wait returns already queued messages, times out without stopping children, and cancels", async () => {
    const { runtime, aborted } = harness();
    const child = await runtime.spawn("parent", "review", "Review");
    await runtime.send(child.id, "/root", "Progress");
    expect((await runtime.wait("parent", 1)).messages[0].text).toBe("Progress");
    expect((await runtime.wait("parent", 1)).timed_out).toBe(true);
    const controller = new AbortController();
    const waiting = runtime.wait("parent", 1000, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(aborted).toEqual([]);
  });

  test("isolates trees and prohibits controlling the root", async () => {
    const { runtime } = harness();
    const a = await runtime.spawn("root_a", "a", "A");
    const b = await runtime.spawn("root_b", "b", "B");
    await expect(runtime.send(a.id, b.id, "Leak")).rejects.toThrow("Unknown agent");
    await expect(runtime.followup(a.id, "root_a", "Take over")).rejects.toThrow("root agent");
    await expect(runtime.control(a.id, "root_a", "close")).rejects.toThrow("root agent");
    expect(runtime.list("root_a").map((agent) => agent.id)).toEqual([a.id]);
  });

  test("rejects self-control by ID and canonical path before changing state or aborting the peer", async () => {
    const { runtime, aborted, snapshots } = harness();
    const child = await runtime.spawn("root", "review", "Review");
    await runtime.started(child.id);
    const before = structuredClone(runtime.state);
    const writes = snapshots.length;

    for (const target of [child.id, "/root/review"]) {
      for (const action of ["interrupt", "close", "resume"] as const) {
        await expect(runtime.control(child.id, target, action)).rejects.toThrow("Agents cannot control themselves");
      }
    }
    expect(aborted).toEqual([]);
    expect(runtime.state).toEqual(before);
    expect(snapshots).toHaveLength(writes);

    // Rejection must not strand the per-agent operation queue or prevent parent control.
    await runtime.control("root", child.id, "interrupt");
    expect(aborted).toEqual([child.id]);
    await runtime.followup("root", child.id, "Continue reviewing");
    await runtime.shutdown();
    expect(aborted).toEqual([child.id, child.id]);
  });

  test("bounds concurrent spawns, unique names and nesting", async () => {
    const { runtime } = harness();
    const results = await Promise.allSettled(Array.from({ length: 7 }, (_, i) => runtime.spawn("root", `task_${i}`, "Task")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(6);
    await expect(runtime.spawn("root", "task_0", "Duplicate")).rejects.toThrow("already exists");
    const separate = harness().runtime;
    const a = await separate.spawn("root", "a", "A");
    const b = await separate.spawn(a.id, "b", "B");
    const c = await separate.spawn(b.id, "c", "C");
    await expect(separate.spawn(c.id, "d", "D")).rejects.toThrow("nesting");
  });

  test("interrupt/close cascades, preserves evidence, and resume does not start work", async () => {
    const { runtime, aborted, deliveries } = harness();
    const a = await runtime.spawn("root", "a", "A");
    const b = await runtime.spawn(a.id, "b", "B");
    await runtime.control("root", a.id, "close");
    expect(aborted).toEqual([a.id, b.id]);
    expect(runtime.list("root").every((agent) => agent.status === "closed")).toBe(true);
    await expect(runtime.send("root", a.id, "Hello")).rejects.toThrow("closed");
    await expect(runtime.followup("root", a.id, "Hello")).rejects.toThrow("closed");
    await runtime.control("root", a.id, "resume");
    expect(deliveries).toHaveLength(2);
    await runtime.followup("root", a.id, "Continue");
    expect(deliveries.at(-1)!.message.text).toBe("Continue");
    expect(runtime.state.messages.map((message) => message.kind)).toContain("close");
  });

  test("provider failures remain observable rather than becoming successful deliveries", async () => {
    const { runtime, fail } = harness();
    fail();
    await expect(runtime.spawn("root", "failure", "Try")).rejects.toThrow("provider unavailable");
    expect(runtime.state.agents[0].status).toBe("failed");
    expect(runtime.state.messages[0]).toMatchObject({ delivery: "failed", error: "Error: provider unavailable", text: "Try" });
  });

  test("shutdown wakes waits and refuses new work", async () => {
    const { runtime } = harness();
    const waiting = runtime.wait("root", 1000);
    await runtime.shutdown();
    await waiting;
    await expect(runtime.spawn("root", "late", "Task")).rejects.toThrow("shutting down");
  });
});

test("wait consumption is persisted and does not replay after reconstruction", async () => {
  const { runtime, snapshots } = harness();
  const child = await runtime.spawn("root", "review", "Review");
  await runtime.send(child.id, "/root", "Done");
  await runtime.wait("root", 1);
  const restored = new SubagentRuntime(snapshots.at(-1)!, {
    async save() {},
    async peer() { throw new Error("Waiting must not start a peer"); },
  });
  expect((await restored.wait("root", 1)).messages).toEqual([]);
});

test("aborted startup records failure evidence and closes its reserved child", async () => {
  const controller = new AbortController();
  const deliveries: string[] = [];
  const aborted: string[] = [];
  const runtime = new SubagentRuntime({ agents: [], messages: [] }, {
    async save() {},
    async peer(id) {
      if (id !== "root") controller.abort(new Error("cancel startup"));
      return {
        model: () => ({ provider: "test", id: "test" }), thinkingLevel: () => "off",
        async send(message) { deliveries.push(message.id); },
        async abort() { aborted.push(id); },
      };
    },
  });
  await expect(runtime.spawn("root", "cancelled", "Task", controller.signal)).rejects.toThrow("cancel startup");
  expect(deliveries).toEqual([]);
  expect(runtime.state.agents[0].status).toBe("closed");
  expect(runtime.state.messages[0].delivery).toBe("failed");
  expect(aborted).toEqual([runtime.state.agents[0].id]);
});

test("close joins an in-flight spawn before aborting the resulting child", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lifecycle: string[] = [];
  const runtime = new SubagentRuntime({ agents: [], messages: [] }, {
    async save() {},
    async peer(id) {
      if (id === "root") await gate;
      return {
        model: () => undefined, thinkingLevel: () => "off",
        async send() { lifecycle.push("task accepted"); },
        async abort() { lifecycle.push("aborted"); },
      };
    },
  });
  const spawn = runtime.spawn("root", "worker", "Task");
  const id = runtime.state.agents[0].id;
  const close = runtime.control("root", id, "close");
  release();
  await Promise.all([spawn, close]);
  expect(lifecycle).toEqual(["task accepted", "aborted"]);
  expect(runtime.state.agents[0].status).toBe("closed");
  await expect(runtime.spawn(id, "orphan", "Task")).rejects.toThrow("Closed agents");
});


describe("persisted incoming dispatch decisions", () => {
  test.each([
    { triggerTurn: true, streaming: false, mode: "immediate", reason: "idle-task" },
    { triggerTurn: false, streaming: false, mode: "queued", reason: "idle-message" },
    { triggerTurn: false, streaming: true, mode: "queued", reason: "working" },
    { triggerTurn: true, streaming: true, mode: "queued", reason: "working" },
  ])("records $reason at dispatch and retains it after delivery", async ({ triggerTurn, streaming, mode, reason }) => {
    const { runtime, snapshots } = harness();
    const child = await runtime.spawn("parent", "explain", "Task");
    const message = runtime.state.messages[0];
    await runtime.dispatching(message.id, triggerTurn, streaming);
    await runtime.delivered(message.id);
    await runtime.finished(child.id, "Done", "completed");
    expect(runtime.state.messages[0]).toMatchObject({ dispatchMode: mode, dispatchReason: reason, delivery: "delivered" });
    expect(snapshots.at(-1)!.messages[0].dispatchReason).toBe(reason);
  });

  test("distinguishes a recipient waiting in wait_agent from other active work", async () => {
    const { runtime } = harness();
    const child = await runtime.spawn("parent", "explain", "Task");
    const waiting = runtime.wait("parent", 1000);
    const message = await runtime.send(child.id, "/root", "Update");
    // The harness bypasses session dispatch, so receipt wakes the wait. Dispatch
    // classification in a real peer must occur before that wake boundary.
    await waiting;
    await runtime.dispatching(message.id, false, true);
    expect(runtime.state.messages.find((entry) => entry.id === message.id)!.dispatchReason).toBe("working");

    const nextWait = runtime.wait("parent", 1000);
    await runtime.dispatching(message.id, false, true);
    expect(runtime.state.messages.find((entry) => entry.id === message.id)!.dispatchReason).toBe("waiting");
    runtime.steer("parent");
    await nextWait;
    expect(runtime.state.messages.find((entry) => entry.id === message.id)!.dispatchReason).toBe("waiting");
  });
});
