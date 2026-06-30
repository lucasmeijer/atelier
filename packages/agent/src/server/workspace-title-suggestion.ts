import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AtelierEventBus } from "@atelier/core";
import { listWorkspaces, setWorkspaceTitle } from "@atelier/workspace";
import { getProviderFastModel } from "./hardcoded-provider-knowledge.ts";
import type { ModelRef } from "./model-state.ts";
import { createPiModelRegistry } from "./pi-config-models.ts";

const pending = new Set<string>();

function promptFor(userPrompt: string): string {
  return `Your job is to come with a slug to describe work that is going to happen in a git branch. the work is initiated with this user prompt:

--
${userPrompt}
--

respond with the name, or with "error" if for some reason there is not enough to go on to make a name.`;
}

function textFromResponse(response: Awaited<ReturnType<typeof completeSimple>>): string {
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

async function workspaceIsUnnamed(workspaceId: string): Promise<boolean> {
  const { workspaces } = await listWorkspaces();
  return workspaces.find((workspace) => workspace.id === workspaceId)?.title === null;
}

function workspaceTitleModelFor(agentModel: ModelRef): ModelRef {
  const fastModel = getProviderFastModel(agentModel.provider);
  return { provider: agentModel.provider, id: fastModel?.id ?? agentModel.id };
}

function logWorkspaceTitleSuggestionError(workspaceId: string, model: ModelRef | undefined, message: string, details: Record<string, unknown> = {}): void {
  console.error("could not suggest workspace title", { workspaceId, model: model ? `${model.provider}/${model.id}` : undefined, message, ...details });
}

export function maybeNameWorkspaceFromAgentPrompt(workspaceId: string, userMessages: string[], options: { events?: AtelierEventBus; agentModel?: ModelRef } = {}): void {
  if (pending.has(workspaceId)) return;
  const promptText = userMessages.map((message) => message.trim()).filter(Boolean).join("\n\n");
  if (!promptText) return;

  pending.add(workspaceId);
  void (async () => {
    const titleModelRef = options.agentModel ? workspaceTitleModelFor(options.agentModel) : undefined;
    try {
      if (!(await workspaceIsUnnamed(workspaceId))) return;
      if (!titleModelRef) {
        logWorkspaceTitleSuggestionError(workspaceId, undefined, "agent model is not selected");
        return;
      }
      const registry = await createPiModelRegistry();
      const model = registry.find?.(titleModelRef.provider, titleModelRef.id);
      if (!model) {
        logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, "model is not available");
        return;
      }
      const requestAuth = await registry.getApiKeyAndHeaders(model);
      if (!requestAuth.ok) {
        logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, requestAuth.error);
        return;
      }
      const response = await completeSimple(model, {
        messages: [{ role: "user", content: promptFor(promptText), timestamp: Date.now() }],
      }, {
        apiKey: requestAuth.apiKey,
        headers: requestAuth.headers,
        env: requestAuth.env,
        reasoning: "minimal",
        maxTokens: 32,
      });
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
      if (!(await workspaceIsUnnamed(workspaceId))) return;
      await setWorkspaceTitle(workspaceId, title);
      await options.events?.emit("workspace_title_changed", { workspaceId, title });
    } catch (error) {
      logWorkspaceTitleSuggestionError(workspaceId, titleModelRef, error instanceof Error ? error.message : String(error), { error });
    } finally {
      pending.delete(workspaceId);
    }
  })();
}
