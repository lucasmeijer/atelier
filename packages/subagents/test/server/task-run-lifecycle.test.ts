import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { configureAgentDelegation } from "../../../agent/src/server/delegation.ts";
import { RealAgentRuntime } from "../../../agent/src/server/real-agent-runtime.ts";
import { AgentServiceTierState } from "../../../agent/src/server/service-tier.ts";
import { createAtelierResourceLoader } from "../../../agent/src/server/system-prompt.ts";
import { turnStartEntryType, turnTimingEntryType } from "../../../agent/src/server/turn-timing.ts";
import { subagentsDelegation } from "../../src/server/delegation.ts";
import { inheritedContextEntryType } from "../../src/server/fork-history.ts";

class TaskRuntime extends RealAgentRuntime {
  protected override async statsView() {
    return { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0,
      modelName: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] };
  }
}

// Exercise Pi's actual event/persistence ordering, not a mock that starts the
// runtime from a user message already in history. Assertions concern durable
// run identity and timing, not transcript presentation.
for (const context of ["inherited", "unfinished-local", "empty"] as const) {
  test(`consumed tasks own their runs with ${context} context, steering, and follow-ups`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "atelier-task-run-"));
    let session: AgentSession | undefined;
    let runtime: TaskRuntime | undefined;
    configureAgentDelegation(subagentsDelegation);
    try {
      const manager = SessionManager.inMemory(dir);
      const historicalId = context !== "empty"
        ? manager.appendMessage({ role: "user", content: "Parent's unfinished request", timestamp: Date.now() })
        : undefined;
      if (context === "inherited") manager.appendCustomEntry(inheritedContextEntryType);
      const authPath = join(dir, "auth.json");
      await writeFile(authPath, JSON.stringify({ openai: { type: "api_key", key: "offline-test" } }));
      const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
      const model = modelRuntime.getModel("openai", "gpt-4o")!;
      ({ session } = await createAgentSession({
        cwd: dir, agentDir: dir, modelRuntime, model, thinkingLevel: "off", sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoader: createAtelierResourceLoader(), tools: [],
      }));
      runtime = new TaskRuntime({ workspaceId: "task-run", conversationId: crypto.randomUUID(),
        label: "Task", title: "Task", path: join(dir, "session.jsonl") }, session, [], new AgentServiceTierState(manager));
      const markers = (type: string) => manager.getBranch().filter((entry) => entry.type === "custom").filter((entry) => entry.customType === type);
      const startsAtLoopStartup: number[] = [];
      session.subscribe((event) => {
        if (event.type === "agent_start") startsAtLoopStartup.push(markers(turnStartEntryType).length);
      });
      const startsAtInference: number[] = [];
      const activeSession = session;
      session.agent.streamFunction = async () => {
        startsAtInference.push(markers(turnStartEntryType).length);
        const stream = createAssistantMessageEventStream();
        const response: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop", content: [{ type: "text", text: "Done" }],
        };
        // Steering consumes another input without starting another outer run.
        if (startsAtInference.length === 1) await activeSession.steer("Additional instructions");
        stream.push({ type: "done", reason: "stop", message: response });
        stream.end();
        return stream;
      };
      for (const text of ["Initial task", "Follow-up task"]) {
        await session.sendCustomMessage({ customType: "subagent", content: text, display: false,
          details: { kind: "task" } }, { triggerTurn: true });
      }
      await session.prompt("A new user prompt");

      const branch = manager.getBranch();
      const tasks = branch.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent");
      const prompt = branch.findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
      const expectedIds = [...tasks.map((entry) => entry.id), prompt.id];
      expect(expectedIds).toHaveLength(3);
      expect(startsAtLoopStartup).toEqual([0, 1, 2]);
      expect(startsAtInference).toEqual([1, 1, 2, 3]);
      expect(markers(turnStartEntryType).map((entry) => entry.data)).toEqual(expectedIds.map((turnEntryId) => ({ turnEntryId, startedAt: expect.any(Number) })));
      expect(markers(turnTimingEntryType).map((entry) => entry.data)).toEqual(expectedIds.map((turnEntryId, index) => expect.objectContaining({
        turnEntryId, outcome: "completed", outputTokens: index === 0 ? 4 : 2,
      })));
      expect(expectedIds).not.toContain(historicalId);
      for (const [index, entry] of markers(turnStartEntryType).entries()) {
        expect(branch.findIndex((candidate) => candidate.id === expectedIds[index])).toBeLessThan(branch.indexOf(entry));
      }
    } finally {
      await runtime?.dispose();
      session?.dispose();
      configureAgentDelegation(undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
