import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAtelierResourceLoader } from "../../../agent/src/server/system-prompt.ts";
import { bindSubagentSession, getSubagents, shutdownSubagents } from "../../src/server/subagents.ts";
import type { SubagentRuntime } from "../../src/server/subagent-runtime.ts";

// Exercise the real Pi queue and lifecycle, with a scripted model and no network.
async function withSession(run: (session: AgentSession, coordinator: SubagentRuntime, probe: (callback: () => Promise<void>) => void) => Promise<void>, agentId = "root") {
  const dir = await mkdtemp(join(tmpdir(), "atelier-wait-"));
  const previous = process.env.ATELIER_DATA_DIR;
  process.env.ATELIER_DATA_DIR = dir;
  const workspaceId = "wait-session";
  let dispose: (() => void | Promise<void>) | undefined;
  let session: AgentSession | undefined;
  let parent: AgentSession | undefined;
  let disposeParent: (() => void | Promise<void>) | undefined;
  try {
    const coordinator = await getSubagents(workspaceId);
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = modelRuntime.getModel("openai", "gpt-4o")!;
    let callback = async () => {};
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime, model, thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      resourceLoader: createAtelierResourceLoader(), tools: ["probe"],
      customTools: [{ name: "probe", label: "Probe", description: "Inspect pending input", parameters: Type.Object({}), async execute() {
        await callback();
        return { content: [{ type: "text", text: "Probe complete" }], details: {} };
      } }],
    }));
    let step = 0;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: step++ === 0 ? "toolUse" : "stop", content: [],
      };
      message.content = message.stopReason === "toolUse" ? [{ type: "toolCall", id: "probe-call", name: "probe", arguments: {} }] : [{ type: "text", text: "Done" }];
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    };
    if (agentId === "child") {
      coordinator.state.agents.push({ id: agentId, parentId: "root", rootId: "root", taskName: "child", task: "Task", depth: 1, status: "completed", thinkingLevel: "off" });
      ({ session: parent } = await createAgentSession({
        cwd: dir, agentDir: dir, modelRuntime, model, resourceLoader: createAtelierResourceLoader(), tools: [],
        sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory(),
      }));
      disposeParent = bindSubagentSession(workspaceId, "root", parent, coordinator).dispose;
    }
    dispose = bindSubagentSession(workspaceId, agentId, session, coordinator).dispose;
    await run(session, coordinator, (fn) => { callback = fn; step = 0; });
  } finally {
    await session?.abort();
    await dispose?.();
    await disposeParent?.();
    parent?.dispose();
    session?.dispose();
    await shutdownSubagents(workspaceId);
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const timeout = { timed_out: true, interrupted: false };
const mailbox = { timed_out: false, interrupted: false };
const steer = { timed_out: false, interrupted: true };

test("Pi context consumption, not wait history, drains agent messages", async () => {
  await withSession(async (session, coordinator, probe) => {
    // Idle ordinary mail is appended directly to context, not left in Pi's queue.
    await coordinator.send("root", "/root", "Already in context");
    const observed: object[] = [];
    probe(async () => {
      observed.push(await coordinator.wait("root", 1));
      const waiting = coordinator.wait("root", 1000);
      await coordinator.send("root", "/root", "Queued during tool execution");
      observed.push(await waiting);
      observed.push(await coordinator.wait("root", 1)); // Wait is not a drain.
    });
    await session.sendCustomMessage({ customType: "test", content: "Inspect queue", display: false }, { triggerTurn: true });
    expect(observed).toEqual([timeout, mailbox, mailbox]);
    expect(session.messages.filter((message) => message.role === "custom" && message.customType === "subagent")).toHaveLength(2);
    expect(await coordinator.wait("root", 1)).toEqual(timeout);
  });
});

test("Pi pending user steering wakes before and during wait and wins over mail", async () => {
  await withSession(async (session, coordinator, probe) => {
    const observed: object[] = [];
    probe(async () => {
      const waiting = coordinator.wait("root", 1000);
      await session.steer("Steered during wait");
      observed.push(await waiting);
      await coordinator.send("root", "/root", "Mailbox also pending");
      observed.push(await coordinator.wait("root", 1));
      observed.push(await coordinator.wait("root", 1));
    });
    await session.sendCustomMessage({ customType: "test", content: "Inspect steering", display: false }, { triggerTurn: true });
    expect(observed).toEqual([steer, steer, steer]);
    expect(await coordinator.wait("root", 1)).toEqual(timeout);
  });
});

test("Pi clearQueue removes undelivered mail and steering from wait activity", async () => {
  await withSession(async (session, coordinator, probe) => {
    const observed: object[] = [];
    probe(async () => {
      await coordinator.send("root", "/root", "Discard this mail");
      await session.steer("Discard this steer");
      session.clearQueue();
      observed.push(await coordinator.wait("root", 1));
      await session.followUp("A follow-up is not pending steering or agent mail");
      observed.push(await coordinator.wait("root", 1));
    });
    await session.sendCustomMessage({ customType: "test", content: "Inspect clearing", display: false }, { triggerTurn: true });
    expect(observed).toEqual([timeout, timeout]);
  });
});


test("a real Pi child's initial and follow-up tasks cannot satisfy its own first wait", async () => {
  await withSession(async (session, coordinator, probe) => {
    const observed: object[] = [];
    for (const task of ["Initial task", "Follow-up task"]) {
      probe(async () => { observed.push(await coordinator.wait("child", 1)); });
      await coordinator.followup("root", "child", task);
      await session.waitForIdle();
      // Delegation persists completion asynchronously after Pi settles.
      const completions = () => coordinator.state.messages.filter((message) => message.kind === "completion" && message.delivery === "delivered");
      for (let attempt = 0; completions().length < observed.length && attempt < 100; attempt++) await Bun.sleep(1);
      expect(completions()).toHaveLength(observed.length);
    }
    expect(observed).toEqual([timeout, timeout]);
    expect(coordinator.state.messages.filter((message) => message.to === "child").map((message) => message.delivery)).toEqual(["delivered", "delivered"]);
  }, "child");
});
