import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { AtelierEventBus } from "@atelier/core";
import { getSubagents, rootAgentStatus } from "./subagents.ts";
import { agentPath, codexStatus, parseForkTurns } from "./subagent-protocol.ts";
import { codexSubagentDescriptions } from "./codex-subagent-descriptions.ts";

export const subagentToolNames = ["spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents", "wait_agent"];
export function createSubagentTools(workspaceId: string, caller: string, events?: AtelierEventBus) {
  const runtime = () => getSubagents(workspaceId, events);
  const tool = (name: keyof typeof codexSubagentDescriptions, parameters: TSchema, execute: (params: any, signal?: AbortSignal, callId?: string) => Promise<object | string>) => defineTool({
    name, label: name.replaceAll("_", " "), description: codexSubagentDescriptions[name], parameters,
    async execute(_callId: string, params: any, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const result = await execute(params, signal, _callId);
      return { content: [{ type: "text" as const, text: result === "" ? "" : JSON.stringify(result) }], details: {} };
    },
  });
  const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
  return [
    tool("spawn_agent", object({
      task_name: Type.String({ description: "Task name for the new agent. Use lowercase letters, digits, and underscores." }),
      message: Type.String({ description: "Initial plain-text task for the new agent." }),
      fork_turns: Type.Optional(Type.String({ description: "Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns." })),
    }), async (params, signal, callId) => {
      const coordinator = await runtime();
      const agent = await coordinator.spawn(caller, params.task_name, params.message, signal, parseForkTurns(params.fork_turns), callId);
      return { task_name: agentPath(coordinator.state, agent.id) };
    }),
    tool("send_message", object({ target: Type.String({ description: "Relative or canonical task name to message (from spawn_agent)." }), message: Type.String({ description: "Message text to queue on the target agent." }) }), async (params, _signal, callId) => {
      await (await runtime()).send(caller, params.target, params.message, callId); return "";
    }),
    tool("followup_task", object({ target: Type.String({ description: "Agent id or canonical task name to send a follow-up task to (from spawn_agent)." }), message: Type.String({ description: "Message text to send to the target agent." }) }), async (params, _signal, callId) => {
      await (await runtime()).followup(caller, params.target, params.message, callId); return "";
    }),
    tool("list_agents", object({ path_prefix: Type.Optional(Type.String({ description: "Task-path prefix filter without a trailing slash. Omit to list all live agents." })) }), async (params) => {
      if (params.path_prefix === "" || params.path_prefix?.endsWith("/")) throw new Error("path_prefix must not have a trailing slash.");
      const coordinator = await runtime();
      const prefix = params.path_prefix ? (params.path_prefix.startsWith("/") ? params.path_prefix : `${agentPath(coordinator.state, caller)}/${params.path_prefix}`) : undefined;
      const agents = [{ agent_name: "/root", agent_status: rootAgentStatus(workspaceId, coordinator.rootId(caller)) }, ...coordinator.list(caller).filter((agent) => agent.status !== "closed").map((agent) => ({ agent_name: agentPath(coordinator.state, agent.id), agent_status: codexStatus(agent) }))];
      return { agents: agents.filter((agent) => !prefix || agent.agent_name === prefix || agent.agent_name.startsWith(`${prefix}/`)).sort((a, b) => a.agent_name.localeCompare(b.agent_name)) };
    }),
    tool("wait_agent", object({ timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds. Defaults to 30000, min 10000, max 3600000." })) }), async (params, signal, callId) => {
      if (params.timeout_ms !== undefined && !Number.isSafeInteger(params.timeout_ms)) throw new Error("timeout_ms must be an integer.");
      const timeout = Math.max(10000, params.timeout_ms ?? 30000);
      const result = await (await runtime()).wait(caller, timeout, signal);
      const message = result.interrupted ? "Wait interrupted by new input." : result.timed_out ? "Wait timed out." : "Wait completed.";
      return { message: params.timeout_ms !== undefined && params.timeout_ms < timeout ? `${message}\n\nRequested timeout of ${params.timeout_ms}ms was clamped to the minimum of ${timeout}ms.` : message, timed_out: result.timed_out };
    }),
    tool("interrupt_agent", object({ target: Type.String({ description: "Agent id or canonical task name to interrupt (from spawn_agent)." }) }), async (params) => {
      const coordinator = await runtime();
      const previous = coordinator.target(caller, params.target);
      await coordinator.control(caller, params.target, "interrupt");
      return { previous_status: codexStatus(previous) };
    }),
  ];
}
