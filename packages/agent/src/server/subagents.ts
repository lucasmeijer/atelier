import { modelDeliveryBatch, parseSubagentDelivery, subagentDeliveryType } from "./subagent-delivery.ts";
import { contentText } from "@earendil-works/pi-ai";
import { finalAssistantText } from "./transcript.ts";
import { messageEnvelope, modelMessage } from "./subagent-protocol.ts";
import { SubagentModelInput } from "./subagent-model-input.ts";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAtelierRuntimeContext, isJsonObject, type AtelierEventBus } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { getWorkspaceAgentRuntime } from "./runtime.ts";
import { listWorkspaceAgentConversations, type WorkspaceAgentConversationInfo } from "./session-store.ts";
import { SubagentRuntime, type SubagentPeer, type SubagentRecord, type SubagentState } from "./subagent-runtime.ts";

const recordSchema = Type.Object({
  id: Type.String(), parentId: Type.String(), rootId: Type.String(), taskName: Type.String(), task: Type.String(), depth: Type.Number(),
  status: Type.Union([Type.Literal("starting"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("interrupted"), Type.Literal("failed"), Type.Literal("closed")]),
  result: Type.Optional(Type.String()), model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })), thinkingLevel: Type.String(), forkTurns: Type.Optional(Type.String()),
});
const stateSchema = Type.Object({ readPositions: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0 }))), agents: Type.Array(recordSchema), messages: Type.Array(Type.Object({
  id: Type.String(), from: Type.String(), to: Type.String(), text: Type.String(), timestamp: Type.String(),
  kind: Type.Union([Type.Literal("task"), Type.Literal("message"), Type.Literal("completion"), Type.Literal("interrupt"), Type.Literal("close"), Type.Literal("resume")]),
  delivery: Type.Union([Type.Literal("queued"), Type.Literal("delivered"), Type.Literal("failed")]), error: Type.Optional(Type.String()), toolCallId: Type.Optional(Type.String()), dispatchMode: Type.Optional(Type.Union([Type.Literal("immediate"), Type.Literal("queued")])), dispatchReason: Type.Optional(Type.Union([Type.Literal("idle-task"), Type.Literal("idle-message"), Type.Literal("working"), Type.Literal("waiting")])),
})) });
const coordinators = new Map<string, Promise<SubagentRuntime>>();
const peers = new Map<string, SubagentPeer>();
const sessions = new Map<string, any>();
const loaded = new Map<string, SubagentRuntime>();
const listeners = new Set<(workspaceId: string) => void>();
export function subagentSnapshot(workspaceId: string): SubagentState { return loaded.get(workspaceId)?.state ?? { agents: [], messages: [] }; }
export function steerSubagents(workspaceId: string, caller: string): void { loaded.get(workspaceId)?.steer(caller); }
export function rootAgentStatus(workspaceId: string, rootId: string) {
  const session = sessions.get(`${workspaceId}:${rootId}`);
  if (!session) throw new Error("Root agent session is not loaded.");
  if (session.isStreaming) return "running";
  const last = session.messages.findLast((message: any) => message.role === "assistant");
  if (last?.stopReason === "aborted") return "interrupted";
  if (last?.stopReason === "error") return { errored: last.errorMessage ?? "Agent failed." };
  return { completed: last ? finalAssistantText(last.content) : null };
}
export function subscribeSubagentChanges(listener: (workspaceId: string) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

export function forkSubagentHistory(workspaceId: string, child: SubagentRecord, manager: any): void {
  if (!child.forkTurns || child.forkTurns === "none" || manager.getBranch().length) return;
  const parent = sessions.get(`${workspaceId}:${child.parentId}`);
  if (!parent) throw new Error("Parent session must be loaded before forking.");
  let messages = parent.messages;
  if (child.forkTurns && child.forkTurns !== "all") {
    const userIndices = messages.flatMap((message: any, index: number) => message.role === "user" || (message.role === "custom" && message.customType === "subagent" && (message.details?.kind === "task" || contentText(message.content).startsWith("Message Type: NEW_TASK\n"))) ? [index] : []);
    messages = messages.slice(userIndices.at(-Number(child.forkTurns)) ?? 0);
  }
  const resultIds = new Set(messages.filter((message: any) => message.role === "toolResult").map((message: any) => message.toolCallId));
  for (const original of messages) {
    const message = structuredClone(original);
    if (message.role === "assistant") {
      message.content = message.content.filter((part: any) => part.type !== "toolCall" || resultIds.has(part.id));
      if (!message.content.length) continue;
    }
    if (message.role === "custom") manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    else manager.appendMessage(message);
  }
}

function directory(workspaceId: string): string { return join(getAtelierRuntimeContext().atelierDataDir, "workspaces", workspaceId, "subagents"); }
export function subagentConversation(workspaceId: string, agent: SubagentRecord): WorkspaceAgentConversationInfo {
  return { workspaceId, conversationId: agent.id, label: agent.taskName, title: agent.taskName, path: join(directory(workspaceId), `${agent.id}.jsonl`) };
}
export function getSubagents(workspaceId: string, events?: AtelierEventBus): Promise<SubagentRuntime> {
  let runtime = coordinators.get(workspaceId);
  if (!runtime) {
    runtime = (async () => {
      const dir = directory(workspaceId);
      const path = join(dir, "state.json");
      const file = Bun.file(path);
      const state: SubagentState = await file.exists() ? Value.Parse(stateSchema, await file.json()) : { agents: [], messages: [] };
      // Inference cannot survive a server restart. Preserve evidence; never silently replay tasks.
      for (const agent of state.agents) {
        if (agent.status === "running" || agent.status === "starting") {
          agent.status = "interrupted";
          agent.result = "Atelier restarted during this task. Use followup_task to continue.";
        }
      }
      for (const message of state.messages) {
        if (message.delivery === "queued") {
          message.delivery = "failed";
          message.error = "Atelier restarted before transcript delivery was acknowledged. Inspect the transcript before resending.";
        }
      }
      const save = async (snapshot: SubagentState) => {
        await mkdir(dir, { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify(snapshot, null, 2) + "\n");
        await rename(`${path}.tmp`, path);
        for (const listener of listeners) listener(workspaceId);
      };
      await save(state);
      const coordinator = new SubagentRuntime(state, {
        save,
        async peer(id) {
          const key = `${workspaceId}:${id}`;
          if (!peers.has(key)) {
            const child = state.agents.find((agent) => agent.id === id);
            const conversation = child ? subagentConversation(workspaceId, child) : (await listWorkspaceAgentConversations(workspaceId)).find((agent) => agent.conversationId === id);
            if (!conversation) throw new Error(`Agent conversation not found: ${id}`);
            await getWorkspaceAgentRuntime(conversation, { events });
          }
          const peer = peers.get(key);
          if (!peer) throw new Error(`Agent session not bound: ${id}`);
          return peer;
        },
      });
      loaded.set(workspaceId, coordinator);
      return coordinator;
    })();
    coordinators.set(workspaceId, runtime);
  }
  return runtime;
}

/** Pi's custom-message queue keeps attribution in context and in the durable transcript.
 * Queue-only traffic never starts idle inference. During a run it steers at the next tool boundary. */
export function bindSubagentSession(workspaceId: string, id: string, session: any, coordinator: SubagentRuntime): void {
  sessions.set(`${workspaceId}:${id}`, session);
  const bridge = new SubagentModelInput();
  const convert = session.agent.convertToLlm;
  let included: SubagentState["messages"] = [];
  let requestsThisTurn = 0;
  session.agent.convertToLlm = async (messages: any[]) => {
    bridge.clear();
    included = [];
    return await convert(messages.map((message) => {
      if (message.role !== "custom" || message.customType !== "subagent") return message;
      const record = coordinator.state.messages.find((candidate) => candidate.id === message.details.subagentMessageId);
      if (!record) throw new Error("Subagent context has no communication record.");
      included.push(record);
      return bridge.forModel(modelMessage(coordinator.state, record), session.model.api, message.timestamp);
    }));
  };
  const previousPayload = session.agent.onPayload;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Pi provider payloads are parsed at this I/O boundary.
  session.agent.onPayload = async (payload: unknown, model: { api: string }) => {
    const transformed = await previousPayload?.(payload, model) ?? payload;
    if (!isJsonObject(transformed)) throw new Error("Expected a provider request object.");
    const providerPayload = bridge.transform(transformed, model.api);
    const branch = session.sessionManager.getBranch();
    const previous = branch.filter((entry: any) => entry.type === "custom" && entry.customType === subagentDeliveryType).map((entry: any) => parseSubagentDelivery(entry.data));
    const turn = branch.findLast((entry: any) => (entry.type === "message" && entry.message.role === "user") || (entry.type === "custom_message" && entry.customType === "subagent" && entry.details?.kind === "task"));
    const batch = modelDeliveryBatch(coordinator.state, id, included, previous, turn?.id ?? "", requestsThisTurn > 0, model.api === "openai-codex-responses" ? "agent_message" : "user");
    requestsThisTurn++;
    if (batch) {
      // This is the provider payload boundary, not a server acknowledgement or read receipt.
      session.sessionManager.appendCustomEntry(subagentDeliveryType, batch);
      for (const listener of listeners) listener(workspaceId);
    }
    return providerPayload;
  };
  peers.set(`${workspaceId}:${id}`, {
    model: () => {
      return { provider: session.model.provider, id: session.model.id };
    },
    thinkingLevel: () => session.thinkingLevel ?? "off",
    async send(message, triggerTurn) {
      const streaming = session.isStreaming;
      const immediate = triggerTurn && !streaming;
      await Promise.all([coordinator.dispatching(message.id, triggerTurn, streaming), (async () => {
        const custom = { customType: "subagent", content: messageEnvelope(coordinator.state, message), display: true, details: { subagentMessageId: message.id, kind: message.kind } };
        if (!immediate) {
          await session.sendCustomMessage(custom, { triggerTurn: streaming ? undefined : false, deliverAs: "steer" });
        } else {
          // Start directly from the task, without a fabricated user prompt. Return on agent_start.
          await new Promise<void>((resolve, reject) => {
            const unsubscribe = session.subscribe((event: any) => { if (event.type === "agent_start") { unsubscribe(); resolve(); } });
            void session.sendCustomMessage(custom, { triggerTurn: true }).then(() => { unsubscribe(); resolve(); }, (error: Error) => { unsubscribe(); reject(error); });
          });
        }
      })()]);
    },
    async abort() {
      session.clearQueue();
      if (session.isCompacting) session.abortCompaction();
      await session.abort();
    },
  });
  session.subscribe((event: any) => {
    let operation: Promise<void> | undefined;
    if (event.type === "agent_start") { requestsThisTurn = 0; operation = coordinator.started(id); }
    if (event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "subagent") {
      operation = coordinator.delivered(event.message.details.subagentMessageId);
    }
    if (event.type === "agent_settled") {
      const last = session.messages.findLast((message: any) => message.role === "assistant");
      const outcome = last?.stopReason === "error" ? "failed" : last?.stopReason === "aborted" ? "interrupted" : "completed";
      operation = coordinator.finished(id, last?.errorMessage || finalAssistantText(last?.content ?? []), outcome);
    }
    void operation?.catch((error) => console.error("Subagent lifecycle failed", { workspaceId, id, error }));
  });
}

export function unbindSubagentSession(workspaceId: string, id: string): void { peers.delete(`${workspaceId}:${id}`); sessions.delete(`${workspaceId}:${id}`); }

export async function shutdownSubagents(workspaceId: string): Promise<void> {
  const coordinator = coordinators.get(workspaceId);
  if (coordinator) await (await coordinator).shutdown();
  for (const key of peers.keys()) if (key.startsWith(`${workspaceId}:`)) peers.delete(key);
  coordinators.delete(workspaceId);
  loaded.delete(workspaceId);
  for (const key of sessions.keys()) if (key.startsWith(`${workspaceId}:`)) sessions.delete(key);
}
