import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentRenderOp } from "../shared/protocol.ts";
import {
  agentActivityEventsId,
  agentActivitySummaryId,
  agentTextId,
  agentTranscriptId,
  domId,
  renderActivitySummary,
  renderAgentTranscript,
  renderNotice,
  renderThinkingEntry,
  renderToolCallEntry,
  renderToolResultSummary,
  renderTurnGroupShell,
} from "./render.ts";
import type { WorkspaceAgentInfo } from "./session-store.ts";
import { createAtelierResourceLoader } from "./system-prompt.ts";
import { createWorkspaceAgentTools } from "./tools.ts";

export type AgentSubscriber = (op: AgentRenderOp) => void;
export type WorkspaceTabBusyListener = (event: { workspaceId: string; tabKey: string; busy: boolean }) => void;

const workspaceTabBusyListeners = new Set<WorkspaceTabBusyListener>();

export function subscribeWorkspaceTabBusy(listener: WorkspaceTabBusyListener): () => void {
  workspaceTabBusyListeners.add(listener);
  return () => workspaceTabBusyListeners.delete(listener);
}

interface TurnRecord {
  id: string;
  userText: string;
  assistantText: string;
  thinkingText: string;
  toolCount: number;
}

export interface WorkspaceAgentRuntime {
  workspaceId: string;
  label: string;
  sessionFile: string;
  isStreaming: boolean;
  subscribe(listener: AgentSubscriber): () => void;
  snapshot(): AgentRenderOp;
  userMessages(): string[];
  submit(text: string): Promise<void>;
  abort(): Promise<void>;
}

const runtimes = new Map<string, Promise<WorkspaceAgentRuntime>>();

function key(workspaceId: string, label: string): string {
  return `${workspaceId}\0${label}`;
}

export function getWorkspaceAgentRuntime(agent: WorkspaceAgentInfo): Promise<WorkspaceAgentRuntime> {
  const runtimeKey = key(agent.workspaceId, agent.label);
  let runtime = runtimes.get(runtimeKey);
  if (!runtime) {
    runtime = process.env.ATELIER_AGENT_FAKE === "1" ? createFakeRuntime(agent) : createRealRuntime(agent);
    runtimes.set(runtimeKey, runtime);
  }
  return runtime;
}

abstract class BaseRuntime implements WorkspaceAgentRuntime {
  workspaceId: string;
  label: string;
  sessionFile: string;
  isStreaming = false;
  protected subscribers = new Set<AgentSubscriber>();
  protected turns: TurnRecord[] = [];
  protected activeTurn: TurnRecord | undefined;

  constructor(agent: WorkspaceAgentInfo) {
    this.workspaceId = agent.workspaceId;
    this.label = agent.label;
    this.sessionFile = agent.path;
  }

  subscribe(listener: AgentSubscriber): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  snapshot(): AgentRenderOp {
    return { type: "replace_html", target: agentTranscriptId(this.workspaceId, this.label), html: renderAgentTranscript(this.turns.map((turn) => this.renderStoredTurn(turn))) };
  }

  userMessages(): string[] {
    return this.turns.map((turn) => turn.userText);
  }

  protected broadcast(op: AgentRenderOp): void {
    for (const subscriber of this.subscribers) subscriber(op);
  }

  protected setBusy(busy: boolean): void {
    if (this.isStreaming === busy) return;
    this.isStreaming = busy;
    for (const listener of workspaceTabBusyListeners) listener({ workspaceId: this.workspaceId, tabKey: `agent:${this.label}`, busy });
  }

  protected startTurn(userText: string): TurnRecord {
    const turn: TurnRecord = { id: crypto.randomUUID(), userText, assistantText: "", thinkingText: "", toolCount: 0 };
    this.turns.push(turn);
    this.activeTurn = turn;
    this.broadcast({ type: "append_html", target: agentTranscriptId(this.workspaceId, this.label), html: renderTurnGroupShell(this.workspaceId, this.label, turn.id, userText) });
    return turn;
  }

  protected appendAssistant(text: string): void {
    if (!this.activeTurn) return;
    this.activeTurn.assistantText += text;
    this.broadcast({ type: "append_text", target: agentTextId(this.workspaceId, this.label, this.activeTurn.id), text });
  }

  protected addThinking(text: string): void {
    const turn = this.activeTurn;
    if (!turn) return;
    const first = !turn.thinkingText;
    turn.thinkingText += text;
    const thinkingId = domId("agent_thinking", this.workspaceId, this.label, turn.id);
    if (first) {
      this.broadcast({ type: "append_html", target: agentActivityEventsId(this.workspaceId, this.label, turn.id), html: renderThinkingEntry(thinkingId) });
      this.updateActivitySummary(turn);
    }
    this.broadcast({ type: "append_text", target: thinkingId, text });
  }

  protected addTool(name: string, status = "running"): string | undefined {
    const turn = this.activeTurn;
    if (!turn) return undefined;
    turn.toolCount += 1;
    const id = domId("agent_tool", this.workspaceId, this.label, turn.id, String(turn.toolCount));
    this.broadcast({ type: "append_html", target: agentActivityEventsId(this.workspaceId, this.label, turn.id), html: renderToolCallEntry(id, name, status) });
    this.updateActivitySummary(turn);
    return id;
  }

  protected finishTool(id: string, name: string, status: string): void {
    this.broadcast({ type: "replace_html", target: id, html: renderToolResultSummary(name, status) });
  }

  protected updateActivitySummary(turn: TurnRecord): void {
    const parts = [];
    if (turn.thinkingText) parts.push("thinking");
    if (turn.toolCount) parts.push(`${turn.toolCount} ${turn.toolCount === 1 ? "tool" : "tools"}`);
    const summary = parts.length ? `internal activity: ${parts.join(", ")}` : "internal activity";
    this.broadcast({ type: "replace_html", target: agentActivitySummaryId(this.workspaceId, this.label, turn.id), html: renderActivitySummary(summary) });
  }

  protected renderStoredTurn(turn: TurnRecord): string {
    return renderTurnGroupShell(this.workspaceId, this.label, turn.id, turn.userText, turn.assistantText);
  }

  abstract submit(text: string): Promise<void>;
  abstract abort(): Promise<void>;
}

class FakeWorkspaceAgentRuntime extends BaseRuntime {
  async init(): Promise<void> {
    await this.loadHistory();
  }

  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.isStreaming) {
      this.addThinking(`\nSteer: ${trimmed}\n`);
      return;
    }
    this.setBusy(true);
    this.broadcast({ type: "set_submit_label", label: "Steer" });
    const turn = this.startTurn(trimmed);
    await this.persist({ type: "turn", id: turn.id, userText: trimmed, assistantText: "" });
    this.addThinking("Inspecting workspace context…\n");
    await delay(80);
    const tool = this.addTool("bash pwd", "running");
    await delay(80);
    if (tool) this.finishTool(tool, "bash pwd", "ok · /repos");
    for (const chunk of ["Fake Atelier agent response for: ", trimmed, "\n\n", "This stream is deterministic and grouped by turn."]) {
      await delay(70);
      this.appendAssistant(chunk);
      await this.persist({ type: "assistant_delta", id: turn.id, text: chunk });
    }
    this.setBusy(false);
    this.broadcast({ type: "set_submit_label", label: "Send" });
  }

  async abort(): Promise<void> {
    this.setBusy(false);
    this.broadcast({ type: "set_submit_label", label: "Send" });
  }

  private async loadHistory(): Promise<void> {
    try {
      const content = await readFile(this.sessionFile, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as { type?: string; id?: string; userText?: string; assistantText?: string; text?: string };
        if (entry.type === "turn" && entry.id && entry.userText) this.turns.push({ id: entry.id, userText: entry.userText, assistantText: entry.assistantText ?? "", thinkingText: "", toolCount: 0 });
        if (entry.type === "assistant_delta" && entry.id && entry.text) {
          const turn = this.turns.find((candidate) => candidate.id === entry.id);
          if (turn) turn.assistantText += entry.text;
        }
      }
    } catch {
      // Empty or missing fake transcript.
    }
  }

  private async persist(entry: unknown): Promise<void> {
    await mkdir(dirname(this.sessionFile), { recursive: true });
    await appendFile(this.sessionFile, `${JSON.stringify(entry)}\n`);
  }
}

class RealWorkspaceAgentRuntime extends BaseRuntime {
  private toolDomIds = new Map<string, string>();

  constructor(agent: WorkspaceAgentInfo, private session: any) {
    super(agent);
    this.isStreaming = Boolean(session.isStreaming);
    session.subscribe((event: any) => this.handleEvent(event));
  }

  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.session.isStreaming || this.isStreaming) {
      await this.session.steer(trimmed);
      return;
    }
    this.startTurn(trimmed);
    this.setBusy(true);
    this.broadcast({ type: "set_submit_label", label: "Steer" });
    void this.session.prompt(trimmed).catch((error: unknown) => {
      this.broadcast({ type: "notice", level: "error", message: error instanceof Error ? error.message : String(error) });
      this.setBusy(false);
      this.broadcast({ type: "set_submit_label", label: "Send" });
    });
  }

  async abort(): Promise<void> {
    await this.session.abort();
    this.setBusy(false);
    this.broadcast({ type: "set_submit_label", label: "Send" });
  }

  private handleEvent(event: any): void {
    if (event.type === "agent_start") {
      this.setBusy(true);
      this.broadcast({ type: "set_submit_label", label: "Steer" });
    } else if (event.type === "agent_end") {
      this.setBusy(false);
      this.broadcast({ type: "set_submit_label", label: "Send" });
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      this.appendAssistant(event.assistantMessageEvent.delta ?? "");
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
      this.addThinking(event.assistantMessageEvent.delta ?? "");
    } else if (event.type === "tool_execution_start") {
      const name = event.toolName || event.name || "tool";
      const id = this.addTool(name, "running");
      const callId = event.toolCallId || event.callId || event.id;
      if (id && callId) this.toolDomIds.set(String(callId), id);
    } else if (event.type === "tool_execution_end") {
      const name = event.toolName || event.name || "tool";
      const callId = event.toolCallId || event.callId || event.id;
      const id = callId ? this.toolDomIds.get(String(callId)) : undefined;
      if (id) this.finishTool(id, name, event.error ? "error" : "ok");
      if (callId) this.toolDomIds.delete(String(callId));
    }
  }
}

async function createFakeRuntime(agent: WorkspaceAgentInfo): Promise<WorkspaceAgentRuntime> {
  const runtime = new FakeWorkspaceAgentRuntime(agent);
  await runtime.init();
  return runtime;
}

async function createRealRuntime(agent: WorkspaceAgentInfo): Promise<WorkspaceAgentRuntime> {
  await ensurePiSessionFile(agent.path);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const sessionManager = SessionManager.open(agent.path, dirname(agent.path), "/repos");
  const { session } = await createAgentSession({
    cwd: "/repos",
    agentDir: dirname(agent.path),
    authStorage,
    modelRegistry,
    resourceLoader: createAtelierResourceLoader(),
    customTools: createWorkspaceAgentTools(agent.workspaceId),
    tools: ["read", "write", "edit", "bash"],
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } } as any),
  });
  return new RealWorkspaceAgentRuntime(agent, session);
}

async function ensurePiSessionFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a");
  await file.close();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

