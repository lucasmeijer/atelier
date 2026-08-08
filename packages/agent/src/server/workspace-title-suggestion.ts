import type { AtelierEventBus } from "@atelier/core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { listWorkspaces, setWorkspaceTitle } from "@atelier/workspace";
import { getProviderFastModel } from "./hardcoded-provider-knowledge.ts";
import type { ModelRef } from "./model-state.ts";
import { createPiModelRuntime } from "./pi-config-models.ts";

const pending = new Set<string>();

function promptFor(userPrompt: string): string {
  return `Your job is to come with a slug to describe work that is going to happen in a git branch. the work is initiated with this user prompt:

--
${userPrompt}
--

respond with the name, or with "error" if for some reason there is not enough to go on to make a name.`;
}

function textFromResponse(response: AssistantMessage): string {
  return response.content
    .filter((block) => block.type === "text")
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

async function workspaceIsUnnamed(workspaceId: string): Promise<boolean> {
  const { workspaces } = await listWorkspaces();
  return workspaces.find((workspace) => workspace.id === workspaceId)?.title === null;
}

function workspaceTitleModelFor(agentModel: ModelRef): ModelRef {
  const fastModel = getProviderFastModel(agentModel.provider);
  return { provider: agentModel.provider, id: fastModel?.id ?? agentModel.id };
}

interface WorkspaceTitleSuggestionErrorDetails {
  responseText?: string;
  stopReason?: AssistantMessage["stopReason"];
  diagnostics?: AssistantMessage["diagnostics"];
  error?: Error;
}

function logWorkspaceTitleSuggestionError(workspaceId: string, model: ModelRef | undefined, message: string, details: WorkspaceTitleSuggestionErrorDetails = {}): void {
  console.error("could not suggest workspace title", { workspaceId, model: model ? `${model.provider}/${model.id}` : undefined, message, ...details });
}

function suggestWorkspaceTitle(workspaceId: string, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef; onlyIfUnnamed: boolean }): void {
  if (pending.has(workspaceId)) return;
  const promptText = userMessages.map((message) => message.trim()).filter(Boolean).join("\n\n");
  if (!promptText) return;

  pending.add(workspaceId);
  void (async () => {
    const titleModelRef = options.agentModel ? workspaceTitleModelFor(options.agentModel) : undefined;
    try {
      if (options.onlyIfUnnamed && !(await workspaceIsUnnamed(workspaceId))) return;
      if (!titleModelRef) {
        logWorkspaceTitleSuggestionError(workspaceId, undefined, "agent model is not selected");
        return;
      }
      const runtime = await createPiModelRuntime();
      const model = runtime.getModel(titleModelRef.provider, titleModelRef.id);
      if (!model) {
        logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, "model is not available");
        return;
      }
      if (!(await runtime.checkAuth(model.provider))) {
        logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, "model authentication is not configured");
        return;
      }
      const response = await runtime.completeSimple(model, {
        messages: [{ role: "user", content: promptFor(promptText), timestamp: Date.now() }],
      }, { reasoning: "minimal", maxTokens: 32 });
      if (response.stopReason === "error") {
        logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, response.errorMessage ?? "model returned an error", {
          stopReason: response.stopReason,
          diagnostics: response.diagnostics,
        });
        return;
      }
      const responseText = textFromResponse(response);
      const title = normalizeSlug(responseText);
      if (!title) {
        if (responseText && responseText.toLowerCase() !== "error") {
          logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, "model returned an unusable workspace title", { responseText, stopReason: response.stopReason });
        }
        return;
      }
      if (options.onlyIfUnnamed && !(await workspaceIsUnnamed(workspaceId))) return;
      await setWorkspaceTitle(workspaceId, title);
      await options.events?.emit("workspace_title_changed", { workspaceId, title });
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, error.message, { error });
    } finally {
      pending.delete(workspaceId);
    }
  })();
}

export function maybeNameWorkspaceFromAgentPrompt(workspaceId: string, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  suggestWorkspaceTitle(workspaceId, userMessages, { ...options, onlyIfUnnamed: true });
}

export function renameWorkspaceFromAgentContext(workspaceId: string, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  suggestWorkspaceTitle(workspaceId, userMessages, { ...options, onlyIfUnnamed: false });
}
