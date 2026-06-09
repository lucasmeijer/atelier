import type { ServerWebSocket } from "bun";
import { AtelierCoreError, type AtelierEventBus } from "@atelier/core";
import type { AgentClientMessage } from "../shared/protocol.ts";
import { getWorkspaceAgentRuntime } from "./runtime.ts";
import { listWorkspaceAgents, type WorkspaceAgentInfo } from "./session-store.ts";

export interface AgentSocketData {
  kind: "agent";
  workspaceId: string;
  label: string;
  agent: WorkspaceAgentInfo;
  unsubscribe?: () => void;
}

export async function validateAgentSocket(url: URL): Promise<AgentSocketData | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/ws$/);
  if (!match) return undefined;
  const workspaceId = decodeURIComponent(match[1]);
  const label = decodeURIComponent(match[2]);
  const agents = await listWorkspaceAgents(workspaceId);
  const agent = agents.find((candidate) => candidate.label === label);
  if (!agent) throw new AtelierCoreError("agent_not_found", `agent not found: ${label}`);
  return { kind: "agent", workspaceId, label, agent };
}

export async function openAgentSocket(ws: ServerWebSocket<AgentSocketData>): Promise<void> {
  try {
    const runtime = await getWorkspaceAgentRuntime(ws.data.agent);
    ws.send(JSON.stringify(runtime.snapshot()));
    ws.send(JSON.stringify({ type: "set_submit_label", label: runtime.isStreaming ? "Steer" : "Send" }));
    ws.data.unsubscribe = runtime.subscribe((op) => {
      try {
        ws.send(JSON.stringify(op));
      } catch {
        // Socket closed.
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ws.send(JSON.stringify({ type: "notice", level: "error", message }));
    ws.close();
  }
}

export async function handleAgentSocketMessage(ws: ServerWebSocket<AgentSocketData>, message: string | Buffer, options: { events?: AtelierEventBus } = {}): Promise<void> {
  const text = typeof message === "string" ? message : message.toString();
  const parsed = JSON.parse(text) as AgentClientMessage;
  const runtime = await getWorkspaceAgentRuntime(ws.data.agent);
  if (parsed.type === "submit") {
    if (parsed.text.trim()) await options.events?.emit("workspace_user_activity", { workspaceId: ws.data.workspaceId });
    await runtime.submit(parsed.text);
  }
  if (parsed.type === "abort") await runtime.abort();
}

export function closeAgentSocket(ws: ServerWebSocket<AgentSocketData>): void {
  ws.data.unsubscribe?.();
}
