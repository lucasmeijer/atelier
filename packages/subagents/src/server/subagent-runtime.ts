import { agentPath } from "./subagent-protocol.ts";
import { randomUUID } from "node:crypto";

export const maxConcurrentSubagents = 6;

export type SubagentStatus = "starting" | "running" | "completed" | "interrupted" | "failed" | "closed";
export interface SubagentRecord {
  id: string;
  parentId: string;
  rootId: string;
  taskName: string;
  task: string;
  depth: number;
  status: SubagentStatus;
  result?: string;
  model?: { provider: string; id: string };
  thinkingLevel: string;
  forkTurns?: string;
}
export type SubagentDispatchReason = "idle-task" | "idle-message" | "working" | "waiting";
export interface SubagentMessage {
  id: string;
  from: string;
  to: string;
  kind: "task" | "message" | "completion" | "interrupt" | "close" | "resume";
  text: string;
  timestamp: string;
  delivery: "queued" | "delivered" | "failed";
  error?: string;
  toolCallId?: string;
  dispatchMode?: "immediate" | "queued";
  dispatchReason?: SubagentDispatchReason;
  queueSizeOnArrival?: number;
}
export interface SubagentState { agents: SubagentRecord[]; messages: SubagentMessage[] }
export type SubagentInputActivity = "steer" | "mailbox";
export interface SubagentPeer {
  model(): { provider: string; id: string } | undefined;
  thinkingLevel(): string;
  /** Current undrained input, not transcript history. Steering takes priority. */
  pendingInput(): SubagentInputActivity | undefined;
  send(message: SubagentMessage, triggerTurn: boolean): Promise<void>;
  abort(): Promise<void>;
}
export interface SubagentDependencies {
  save(state: SubagentState): Promise<void>;
  peer(id: string): Promise<SubagentPeer>;
}

/** Owns delegation, identity, lifecycle and the plaintext communication ledger.
 * Peers own inference and transcripts; messages never start turns unless explicitly tasks. */
export class SubagentRuntime {
  private writes: Promise<void> = Promise.resolve();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly operations = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(readonly state: SubagentState, private readonly dependencies: SubagentDependencies) {}

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const write = this.writes.then(() => this.dependencies.save(snapshot));
    this.writes = write;
    return write;
  }

  rootId(id: string): string { return this.state.agents.find((agent) => agent.id === id)?.rootId ?? id; }

  private resolve(caller: string, target: string): string {
    const root = this.rootId(caller);
    if (target === root || target === "/root") return root;
    const path = target.startsWith("/") ? target : `${agentPath(this.state, caller)}/${target}`;
    const agent = this.state.agents.find((candidate) => candidate.rootId === root && (candidate.id === target || agentPath(this.state, candidate.id) === path));
    if (!agent) throw new Error(`Unknown agent in this delegation tree: ${target}`);
    return agent.id;
  }

  target(caller: string, target: string): SubagentRecord {
    const id = this.resolve(caller, target);
    const agent = this.state.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new Error("The root agent cannot be assigned tasks or interrupted by collaboration tools.");
    return structuredClone(agent);
  }

  private controlled(caller: string, target: string): SubagentRecord {
    const snapshot = this.target(caller, target);
    return this.state.agents.find((agent) => agent.id === snapshot.id)!;
  }

  list(caller: string): SubagentRecord[] {
    return structuredClone(this.state.agents.filter((agent) => agent.rootId === this.rootId(caller)));
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(id) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.operations.set(id, settled);
    void settled.then(() => { if (this.operations.get(id) === settled) this.operations.delete(id); });
    return result;
  }

  async spawn(caller: string, taskName: string, task: string, signal?: AbortSignal, forkTurns = "all", toolCallId?: string): Promise<SubagentRecord> {
    signal?.throwIfAborted();
    if (this.stopping) throw new Error("Workspace is shutting down.");
    if (!/^[a-z0-9_]+$/.test(taskName)) throw new Error("task_name must use lowercase letters, digits and underscores.");
    if (!task.trim()) throw new Error("message must not be empty.");
    if (this.state.agents.find((agent) => agent.id === caller)?.status === "closed") throw new Error("Closed agents cannot delegate work.");
    const rootId = this.rootId(caller);
    const depth = (this.state.agents.find((agent) => agent.id === caller)?.depth ?? 0) + 1;
    if (depth > 3) throw new Error("Maximum subagent nesting depth is 3.");
    if (this.state.agents.some((agent) => agent.parentId === caller && agent.taskName === taskName)) throw new Error(`Task name already exists: ${taskName}. Use followup_task to reuse it.`);
    if (this.state.agents.filter((agent) => agent.rootId === rootId && (agent.status === "starting" || agent.status === "running")).length >= maxConcurrentSubagents) throw new Error(`At most ${maxConcurrentSubagents} concurrently running subagents per delegation tree. Wait for a task to finish before spawning another.`);
    const agent: SubagentRecord = { id: randomUUID(), parentId: caller, rootId, taskName, task, depth, status: "starting", thinkingLevel: "off", forkTurns };
    // Reserve before awaiting: concurrent spawn calls share the same capacity and name checks.
    this.state.agents.push(agent);
    return await this.serialize(agent.id, async () => {
      try {
        const parent = await this.dependencies.peer(caller);
        agent.model = parent.model();
        agent.thinkingLevel = parent.thinkingLevel();
        await this.persist();
        await this.deliver(caller, agent.id, "task", task, true, signal, toolCallId);
        signal?.throwIfAborted();
        return structuredClone(agent);
      } catch (error) {
        agent.status = signal?.aborted ? "closed" : "failed";
        agent.result = String(error);
        if (signal?.aborted) await (await this.dependencies.peer(agent.id)).abort();
        await this.persist();
        throw error;
      }
    });
  }

  inputChanged(id: string): void { for (const check of this.waiters.get(id) ?? []) check(); }

  private async deliver(from: string, to: string, kind: SubagentMessage["kind"], text: string, triggerTurn: boolean, signal?: AbortSignal, toolCallId?: string): Promise<SubagentMessage> {
    if (this.stopping) throw new Error("Workspace is shutting down.");
    // Like Codex, completion reports may carry no assistant text.
    if (kind !== "completion" && !text.trim()) throw new Error("message must not be empty.");
    const message: SubagentMessage = { id: randomUUID(), from, to, kind, text, timestamp: new Date().toISOString(), delivery: "queued", toolCallId };
    this.state.messages.push(message);
    await this.persist();
    try {
      const peer = await this.dependencies.peer(to);
      signal?.throwIfAborted();
      if (this.stopping) throw new Error("Workspace is shutting down.");
      if (this.state.agents.some((agent) => (agent.id === from || agent.id === to) && agent.status === "closed")) throw new Error("Cannot deliver messages from or to a closed agent.");
      await peer.send(structuredClone(message), triggerTurn);
      // The peer acknowledges actual transcript delivery separately. Queued is not read.
      return structuredClone(message);
    } catch (error) {
      message.delivery = "failed";
      message.error = String(error);
      await this.persist();
      throw error;
    }
  }

  async dispatching(id: string, triggerTurn: boolean, streaming: boolean, readMessageIds: ReadonlySet<string>): Promise<void> {
    const message = this.state.messages.find((candidate) => candidate.id === id);
    if (!message) throw new Error(`Unknown subagent message: ${id}`);
    message.dispatchMode = triggerTurn && !streaming ? "immediate" : "queued";
    message.dispatchReason = streaming ? (this.waiters.has(message.to) ? "waiting" : "working") : triggerTurn ? "idle-task" : "idle-message";
    if (message.dispatchMode === "queued") message.queueSizeOnArrival = unreadMessageCount(this.state, message.to, readMessageIds);
    await this.persist();
  }

  async delivered(id: string): Promise<void> {
    const message = this.state.messages.find((candidate) => candidate.id === id);
    if (!message) throw new Error(`Unknown subagent message: ${id}`);
    message.delivery = "delivered";
    await this.persist();
  }

  async send(caller: string, target: string, text: string, toolCallId?: string): Promise<SubagentMessage> {
    const id = this.resolve(caller, target);
    if (this.state.agents.find((agent) => agent.id === id)?.status === "closed") throw new Error("Agent is closed. Its parent must resume it first.");
    return await this.deliver(caller, id, "message", text, false, undefined, toolCallId);
  }

  async followup(caller: string, target: string, text: string, toolCallId?: string): Promise<SubagentMessage> {
    const agent = this.controlled(caller, target);
    return await this.serialize(agent.id, async () => {
      if (agent.status === "closed") throw new Error("Agent is closed. Resume it first.");
      if (agent.status !== "running" && agent.status !== "starting") {
        if (this.list(caller).filter((candidate) => candidate.status === "running" || candidate.status === "starting").length >= maxConcurrentSubagents) throw new Error(`At most ${maxConcurrentSubagents} concurrently running subagents per delegation tree.`);
        agent.status = "starting";
        agent.result = undefined;
      }
      try { return await this.deliver(caller, agent.id, "task", text, true, undefined, toolCallId); }
      catch (error) { agent.status = "failed"; agent.result = String(error); await this.persist(); throw error; }
    });
  }

  async control(caller: string, target: string, action: "interrupt" | "close" | "resume"): Promise<SubagentRecord> {
    const agent = this.controlled(caller, target);
    // Pi abort waits for the target's tools to finish, including this call if it targets itself.
    if (agent.id === caller) throw new Error("Agents cannot control themselves.");
    return await this.serialize(agent.id, async () => {
      if (action === "resume") {
        if (agent.status !== "closed") throw new Error("Only closed agents can be resumed.");
        if (this.list(caller).filter((candidate) => candidate.status !== "closed").length >= 6) throw new Error("At most 6 open subagents per delegation tree.");
        agent.status = "interrupted";
      } else {
        agent.status = action === "close" ? "closed" : "interrupted";
        await this.persist();
        await (await this.dependencies.peer(agent.id)).abort();
        for (const message of this.state.messages.filter((message) => message.to === agent.id && message.delivery === "queued")) {
          message.delivery = "failed";
          message.error = `Agent ${action === "close" ? "closed" : "interrupted"} before transcript delivery.`;
        }
        for (const child of this.state.agents.filter((candidate) => action === "close" && candidate.parentId === agent.id && candidate.status !== "closed")) {
          await this.control(agent.id, child.id, action);
        }
      }
      this.state.messages.push({ id: randomUUID(), from: caller, to: agent.id, kind: action, text: action === "resume" ? "Session reopened. Use followup_task to start work." : `Agent ${action === "close" ? "closed" : "interrupted"}; transcript retained.`, timestamp: new Date().toISOString(), delivery: "delivered" });
      await this.persist();
      return structuredClone(agent);
    });
  }

  async started(id: string): Promise<void> {
    const agent = this.state.agents.find((candidate) => candidate.id === id);
    if (!agent) return;
    agent.status = "running";
    agent.result = undefined;
    await this.persist();
  }

  async finished(id: string, result: string, outcome: "completed" | "failed" | "interrupted"): Promise<void> {
    const agent = this.state.agents.find((candidate) => candidate.id === id);
    if (!agent || agent.status === "closed" || agent.status === "interrupted" || this.stopping) return;
    agent.status = outcome;
    agent.result = result;
    await this.persist();
    if (outcome !== "interrupted") await this.deliver(id, agent.parentId, "completion", outcome === "failed" ? `Agent errored: ${result}\n\nThis agent's turn failed. If you still need this agent, use the available collaboration tools to give it another task.` : result, false);
  }

  async wait(caller: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<{ timed_out: boolean; interrupted: boolean }> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("timeout_ms must be between 1 and 3600000.");
    signal?.throwIfAborted();
    const peer = await this.dependencies.peer(caller);
    signal?.throwIfAborted();
    // Subscribe and inspect without an await between them. Input queued while resolving
    // the peer is still pending; a completed wait never consumes that input itself.
    return await new Promise((resolve, reject) => {
      const listeners = this.waiters.get(caller) ?? new Set();
      this.waiters.set(caller, listeners);
      const cleanup = () => { clearTimeout(timer); listeners.delete(check); if (!listeners.size) this.waiters.delete(caller); signal?.removeEventListener("abort", abort); };
      const check = () => {
        const activity = peer.pendingInput();
        if (!this.stopping && !activity) return;
        cleanup();
        resolve({ timed_out: false, interrupted: this.stopping || activity === "steer" });
      };
      const abort = () => { cleanup(); reject(signal!.reason); };
      const timer = setTimeout(() => { cleanup(); resolve({ timed_out: true, interrupted: false }); }, timeoutMs);
      listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const id of this.waiters.keys()) this.inputChanged(id);
    await Promise.all(this.state.agents.filter((agent) => agent.status === "running" || agent.status === "starting").map(async (agent) => {
      await (await this.dependencies.peer(agent.id)).abort();
    }));
    await Promise.all([...this.operations.values()]);
    await this.writes;
  }
}

/** Messages awaiting their first prepared model request, including mail already in context. */
export function unreadMessageCount(state: SubagentState, recipient: string, readMessageIds: ReadonlySet<string>): number {
  return state.messages.filter((message) => message.to === recipient && ["task", "message", "completion"].includes(message.kind) && message.delivery !== "failed" && !readMessageIds.has(message.id)).length;
}
