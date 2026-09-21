import { createKeyedOperationQueue, type AtelierEventBus } from "@atelier/core";
import { getWorkspaceTitle, listWorkspaces, setWorkspaceTitle } from "@atelier/workspace";
import { resolveNewWorkspaceAgentModel } from "./model-state.ts";
import { createPiModelRuntime, type ModelRef } from "@atelier/llm/server";
import { listWorkspaceAgentConversations, setWorkspaceAgentConversationTitle, untitledAgentConversationTitle, type WorkspaceAgentConversationInfo } from "./session-store.ts";

const pendingRenames = new Set<string>();

/**
 * A slug needs no reasoning, and asking for one shrinks the answer room a thinking
 * budget would need: Anthropic rejects the resulting sub-1024 token budget outright.
 */
export const agentTitleRequestOptions = { maxTokens: 64 } as const;

export function createAutomaticWorkspaceNamingGate() {
  const active = new Set<string>();
  const completed = new Set<string>();
  return async (workspaceId: string, name: () => Promise<boolean>): Promise<void> => {
    if (active.has(workspaceId) || completed.has(workspaceId)) return;
    active.add(workspaceId);
    try {
      if (await name()) completed.add(workspaceId);
    } finally {
      active.delete(workspaceId);
    }
  };
}

const automaticallyNameWorkspace = createAutomaticWorkspaceNamingGate();
const automaticallyNameConversation = createAutomaticWorkspaceNamingGate();
const serializeTitleOperation = createKeyedOperationQueue();

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
      if (options.onlyIfUnnamed && current.title !== untitledAgentConversationTitle) return { agent: current, workspaceNamed: false, unchanged: true };
      const renamed = await store.setConversationTitle(current, title);
      const workspaceShouldFollow = await store.workspaceShouldFollowAgentTitle(agent.workspaceId, current.title);
      if (workspaceShouldFollow) await store.setWorkspaceTitle(agent.workspaceId, title);
      return { agent: renamed, workspaceNamed: workspaceShouldFollow };
    });
    if (result.unchanged) return result.agent;
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

interface AgentTitleSuggestionErrorDetails {
  stopReason?: string;
  diagnostics?: unknown;
  responseText?: string;
  error?: unknown;
}

function logAgentTitleSuggestionError(agent: { workspaceId: string; conversationId?: string }, model: ModelRef | undefined, message: string, details: AgentTitleSuggestionErrorDetails = {}): void {
  console.error("could not suggest Agent session title", { workspaceId: agent.workspaceId, conversationId: agent.conversationId, model: model ? `${model.provider}/${model.id}` : undefined, message, ...details });
}

function suggestAgentTitle(agent: { workspaceId: string; conversationId?: string }, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef; onlyIfUnnamed: boolean }): void {
  const promptText = userMessages.map((message) => message.trim()).filter(Boolean).join("\n\n");
  if (!promptText) return;

  const suggest = async (): Promise<boolean> => {
    let titleModelRef = options.agentModel;
    try {
      // The persisted title also suppresses automatic naming after a server restart.
      if (options.onlyIfUnnamed) {
        if (agent.conversationId) {
          const conversation = (await listWorkspaceAgentConversations(agent.workspaceId)).find((candidate) => candidate.conversationId === agent.conversationId);
          if (!conversation) throw new Error(`Agent conversation not found: ${agent.conversationId}`);
          if (conversation.title !== untitledAgentConversationTitle) return true;
        } else if (await getWorkspaceTitle(agent.workspaceId) !== null) return true;
      }
      if (!titleModelRef && !agent.conversationId) titleModelRef = await resolveNewWorkspaceAgentModel();
      if (!titleModelRef) {
        logAgentTitleSuggestionError(agent, undefined, "agent model is not selected");
        return false;
      }
      const runtime = await createPiModelRuntime();
      const model = runtime.getModels(titleModelRef.provider)
        .toSorted((a, b) => a.cost.input - b.cost.input)[0];
      if (!model) {
        logAgentTitleSuggestionError(agent, titleModelRef, "provider has no models available");
        return false;
      }
      titleModelRef = { provider: model.provider, id: model.id };
      if (!(await runtime.checkAuth(model.provider))) {
        logAgentTitleSuggestionError(agent, titleModelRef, "model authentication is not configured");
        return false;
      }
      const response = await runtime.completeSimple(model, {
        messages: [{ role: "user", content: promptFor(promptText), timestamp: Date.now() }],
      }, agentTitleRequestOptions);
      if (response.stopReason === "error") {
        logAgentTitleSuggestionError(agent, titleModelRef, response.errorMessage ?? "model returned an error", {
          stopReason: response.stopReason,
          diagnostics: response.diagnostics,
        });
        return false;
      }
      const responseText = textFromResponse(response);
      const title = normalizeSlug(responseText);
      if (!title) {
        if (responseText.toLowerCase() !== "error") {
          logAgentTitleSuggestionError(agent, titleModelRef, "model returned an unusable Agent session title", { responseText, stopReason: response.stopReason });
        }
        return false;
      }
      if (options.onlyIfUnnamed && !agent.conversationId) {
        await serializeTitleOperation(agent.workspaceId, async () => {
          // Recheck after the LLM returns: a manual title always wins.
          if (await getWorkspaceTitle(agent.workspaceId) !== null) return;
          await setWorkspaceTitle(agent.workspaceId, title);
          await options.events?.emit("workspace_title_changed", { workspaceId: agent.workspaceId, title });
          const conversations = await listWorkspaceAgentConversations(agent.workspaceId);
          const conversation = conversations[0];
          if (conversation?.title === untitledAgentConversationTitle) {
            await setWorkspaceAgentConversationTitle(conversation, title);
            await options.events?.emit("workspace_agent_conversation_title_changed", { workspaceId: agent.workspaceId, conversationId: conversation.conversationId, title });
          }
        });
      } else {
        const conversation = (await listWorkspaceAgentConversations(agent.workspaceId)).find((candidate) => candidate.conversationId === agent.conversationId)!;
        await setAgentSessionTitle(conversation, title, { events: options.events, onlyIfUnnamed: options.onlyIfUnnamed });
      }
      return true;
    } catch (error) {
      logAgentTitleSuggestionError(agent, titleModelRef, error instanceof Error ? error.message : String(error), { error });
      return false;
    }
  };
  if (options.onlyIfUnnamed) {
    if (agent.conversationId) {
      void automaticallyNameConversation(`${agent.workspaceId}:${agent.conversationId}`, suggest);
    } else {
      void automaticallyNameWorkspace(agent.workspaceId, suggest);
    }
  } else {
    const key = `${agent.workspaceId}:${agent.conversationId}`;
    if (pendingRenames.has(key)) return;
    pendingRenames.add(key);
    void suggest().finally(() => pendingRenames.delete(key));
  }
}

export function maybeNameAgentFromPrompt(agent: WorkspaceAgentConversationInfo, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  suggestAgentTitle(agent, userMessages, { ...options, onlyIfUnnamed: true });
}

export function renameAgentFromContext(agent: WorkspaceAgentConversationInfo, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  suggestAgentTitle(agent, userMessages, { ...options, onlyIfUnnamed: false });
}

export function maybeNameWorkspaceFromPrompt(workspaceId: string, prompt: string, options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  suggestAgentTitle({ workspaceId }, [prompt], { ...options, onlyIfUnnamed: true });
}
