import type { AtelierEventBus } from "@atelier/core";
import { listWorkspaces, setWorkspaceTitle } from "@atelier/workspace";
import { getProviderFastModel } from "./hardcoded-provider-knowledge.ts";
import type { ModelRef } from "./model-state.ts";
import { createPiModelRuntime } from "./pi-config-models.ts";
import { listWorkspaceAgentConversations, setWorkspaceAgentConversationTitle, untitledAgentConversationTitle, type WorkspaceAgentConversationInfo } from "./session-store.ts";

const pending = new Set<string>();
const titleOperationQueues = new Map<string, Promise<void>>();

function promptFor(userPrompt: string): string {
  return `Your job is to come with a slug to describe an agent session. The session was initiated with this user prompt:

--
${userPrompt}
--

respond with the name, or with "error" if for some reason there is not enough to go on to make a name.`;
}

function textFromResponse(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function normalizeSlug(value: string): string | undefined {
  const firstLine = value.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const withoutQuotes = firstLine.replace(/^`+|`+$/g, "").replace(/^["']|["']$/g, "").trim();
  if (!withoutQuotes || withoutQuotes.toLowerCase() === "error") return undefined;
  const slug = withoutQuotes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || undefined;
}

async function workspaceShouldFollowAgentTitle(workspaceId: string, agentTitle: string): Promise<boolean> {
  const { workspaces } = await listWorkspaces();
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  return workspace?.title === null || workspace?.title === agentTitle;
}

async function serializeTitleOperation<Result>(workspaceId: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = titleOperationQueues.get(workspaceId) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  titleOperationQueues.set(workspaceId, settled);
  void settled.then(() => {
    if (titleOperationQueues.get(workspaceId) === settled) titleOperationQueues.delete(workspaceId);
  });
  return await result;
}

interface AgentSessionTitleStore {
  listConversations(workspaceId: string): Promise<WorkspaceAgentConversationInfo[]>;
  setConversationTitle(agent: WorkspaceAgentConversationInfo, title: string): Promise<WorkspaceAgentConversationInfo>;
  workspaceShouldFollowAgentTitle(workspaceId: string, agentTitle: string): Promise<boolean>;
  setWorkspaceTitle(workspaceId: string, title: string): Promise<void>;
}

export function createAgentSessionTitleSetter(store: AgentSessionTitleStore) {
  return async (agent: WorkspaceAgentConversationInfo, title: string, options: { events?: AtelierEventBus; onlyIfUnnamed?: boolean } = {}): Promise<WorkspaceAgentConversationInfo> => {
    const result = await serializeTitleOperation(agent.workspaceId, async () => {
      const current = (await store.listConversations(agent.workspaceId)).find((candidate) => candidate.conversationId === agent.conversationId);
      if (!current) throw new Error(`Agent conversation not found: ${agent.conversationId}`);
      if (options.onlyIfUnnamed && current.title !== untitledAgentConversationTitle) return { agent: current, changed: false, workspaceNamed: false };
      const renamed = await store.setConversationTitle(current, title);
      const workspaceShouldFollow = await store.workspaceShouldFollowAgentTitle(agent.workspaceId, current.title);
      if (workspaceShouldFollow) await store.setWorkspaceTitle(agent.workspaceId, title);
      return { agent: renamed, changed: true, workspaceNamed: workspaceShouldFollow };
    });
    if (!result.changed) return result.agent;
    await options.events?.emit("workspace_agent_conversation_title_changed", { workspaceId: agent.workspaceId, conversationId: agent.conversationId, title });
    if (result.workspaceNamed) await options.events?.emit("workspace_title_changed", { workspaceId: agent.workspaceId, title });
    return result.agent;
  };
}

export const setAgentSessionTitle = createAgentSessionTitleSetter({
  listConversations: listWorkspaceAgentConversations,
  setConversationTitle: setWorkspaceAgentConversationTitle,
  workspaceShouldFollowAgentTitle,
  setWorkspaceTitle: async (workspaceId, title) => { await setWorkspaceTitle(workspaceId, title); },
});

function agentTitleModelFor(agentModel: ModelRef): ModelRef {
  const fastModel = getProviderFastModel(agentModel.provider);
  return { provider: agentModel.provider, id: fastModel?.id ?? agentModel.id };
}

interface AgentTitleSuggestionErrorDetails {
  stopReason?: string;
  diagnostics?: unknown;
  responseText?: string;
  error?: unknown;
}

function logAgentTitleSuggestionError(agent: WorkspaceAgentConversationInfo, model: ModelRef | undefined, message: string, details: AgentTitleSuggestionErrorDetails = {}): void {
  console.error("could not suggest Agent session title", { workspaceId: agent.workspaceId, conversationId: agent.conversationId, model: model ? `${model.provider}/${model.id}` : undefined, message, ...details });
}

function suggestAgentTitle(agent: WorkspaceAgentConversationInfo, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef; onlyIfUnnamed: boolean }): void {
  const pendingKey = `${agent.workspaceId}:${agent.conversationId}`;
  if (pending.has(pendingKey)) return;
  const promptText = userMessages.map((message) => message.trim()).filter(Boolean).join("\n\n");
  if (!promptText) return;

  pending.add(pendingKey);
  void (async () => {
    const titleModelRef = options.agentModel ? agentTitleModelFor(options.agentModel) : undefined;
    try {
      if (options.onlyIfUnnamed && agent.title !== untitledAgentConversationTitle) return;
      if (!titleModelRef) {
        logAgentTitleSuggestionError(agent, undefined, "agent model is not selected");
        return;
      }
      const runtime = await createPiModelRuntime();
      const model = runtime.getModel(titleModelRef.provider, titleModelRef.id);
      if (!model) {
        logAgentTitleSuggestionError(agent, titleModelRef, "model is not available");
        return;
      }
      if (!(await runtime.checkAuth(model.provider))) {
        logAgentTitleSuggestionError(agent, titleModelRef, "model authentication is not configured");
        return;
      }
      const response = await runtime.completeSimple(model, {
        messages: [{ role: "user", content: promptFor(promptText), timestamp: Date.now() }],
      }, { reasoning: "minimal", maxTokens: 32 });
      if (response.stopReason === "error") {
        logAgentTitleSuggestionError(agent, titleModelRef, response.errorMessage ?? "model returned an error", {
          stopReason: response.stopReason,
          diagnostics: response.diagnostics,
        });
        return;
      }
      const responseText = textFromResponse(response);
      const title = normalizeSlug(responseText);
      if (!title) {
        if (responseText && responseText.toLowerCase() !== "error") {
          logAgentTitleSuggestionError(agent, titleModelRef, "model returned an unusable Agent session title", { responseText, stopReason: response.stopReason });
        }
        return;
      }
      await setAgentSessionTitle(agent, title, { events: options.events, onlyIfUnnamed: options.onlyIfUnnamed });
    } catch (error) {
      logAgentTitleSuggestionError(agent, titleModelRef, error instanceof Error ? error.message : String(error), { error });
    } finally {
      pending.delete(pendingKey);
    }
  })();
}

export function maybeNameAgentFromPrompt(agent: WorkspaceAgentConversationInfo, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  suggestAgentTitle(agent, userMessages, { ...options, onlyIfUnnamed: true });
}

export function renameAgentFromContext(agent: WorkspaceAgentConversationInfo, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  suggestAgentTitle(agent, userMessages, { ...options, onlyIfUnnamed: false });
}
