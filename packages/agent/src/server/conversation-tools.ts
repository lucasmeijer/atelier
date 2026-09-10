import type { JsonObject } from "@atelier/core";
import type { AgentToolBinding } from "@atelier/shared";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Registration does not expose the tool; only an explicit conversation binding does. */
type ConversationToolFactory = (context: JsonObject, workspaceId: string) => ToolDefinition<any, any>;
const factories = new Map<string, ConversationToolFactory>();

export function registerConversationAgentTool(name: string, factory: ConversationToolFactory): () => void {
  if (factories.has(name)) throw new Error(`Conversation tool already registered: ${name}`);
  factories.set(name, factory);
  return () => { factories.delete(name); };
}

export function loadConversationTools(bindings: AgentToolBinding[], workspaceId: string): ToolDefinition<any, any>[] {
  const names = new Set<string>();
  return bindings.map((binding) => {
    if (names.has(binding.name)) throw new Error(`Duplicate conversation tool: ${binding.name}`);
    names.add(binding.name);
    const factory = factories.get(binding.name);
    if (!factory) throw new Error(`Unknown conversation tool: ${binding.name}`);
    const tool = factory(binding.context, workspaceId);
    if (tool.name !== binding.name) throw new Error(`Conversation tool factory name mismatch: ${binding.name}`);
    return tool;
  });
}
