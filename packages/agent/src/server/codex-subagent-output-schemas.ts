import type { JsonObject } from "@atelier/core";
// OpenAI Codex, Apache-2.0; multi_agents_spec.rs at 574a36ff99f0807a24f5b043f593122bf151908d.
const status: JsonObject = { oneOf: [
  { type: "string", enum: ["pending_init", "running", "interrupted", "shutdown", "not_found"] },
  { type: "object", properties: { completed: { type: ["string", "null"] } }, required: ["completed"], additionalProperties: false },
  { type: "object", properties: { errored: { type: "string" } }, required: ["errored"], additionalProperties: false },
] };
export const codexSubagentOutputSchemas = new Map<string, JsonObject>(Object.entries<JsonObject>({
  spawn_agent: { type: "object", properties: { task_name: { type: "string", description: "Canonical task name for the spawned agent." } }, required: ["task_name"], additionalProperties: false },
  list_agents: { type: "object", properties: { agents: { type: "array", items: { type: "object", properties: { agent_name: { type: "string", description: "Canonical task name for the agent when available, otherwise the agent id." }, agent_status: { description: "Last known status of the agent.", allOf: [status] } }, required: ["agent_name", "agent_status"], additionalProperties: false }, description: "Live agents visible in the current root thread tree." } }, required: ["agents"], additionalProperties: false },
  wait_agent: { type: "object", properties: { message: { type: "string", description: "Brief wait summary without the agent's final content, including any timeout adjustment." }, timed_out: { type: "boolean", description: "Whether the wait call returned because no mailbox update arrived before the timeout." } }, required: ["message", "timed_out"], additionalProperties: false },
  interrupt_agent: { type: "object", properties: { previous_status: { description: "The agent status observed before the interrupt request was handled.", allOf: [status] } }, required: ["previous_status"], additionalProperties: false },
}));
