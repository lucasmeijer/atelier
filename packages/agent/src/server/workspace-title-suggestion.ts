import { join } from "node:path";
import { completeSimple, getModel } from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { AtelierEventBus } from "@atelier/core";
import { listWorkspaces, setWorkspaceTitle } from "@atelier/workspace";
import { piConfigSeedDir } from "./pi-config-seed.ts";

const pending = new Set<string>();
const model = getModel("openai-codex", "gpt-5.4-mini");

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

async function getCodexApiKeyFromPiConfig(): Promise<string | undefined> {
  const authStorage = AuthStorage.create(join(await piConfigSeedDir(), "auth.json"));
  return await authStorage.getApiKey("openai-codex");
}

function logWorkspaceTitleSuggestionError(workspaceId: string, message: string, details: Record<string, unknown> = {}): void {
  console.error("could not suggest workspace title", { workspaceId, model: `${model.provider}/${model.id}`, message, ...details });
}

export function maybeNameWorkspaceFromAgentPrompt(workspaceId: string, userMessages: string[], options: { events?: AtelierEventBus } = {}): void {
  if (pending.has(workspaceId)) return;
  const promptText = userMessages.map((message) => message.trim()).filter(Boolean).join("\n\n");
  if (!promptText) return;

  pending.add(workspaceId);
  void (async () => {
    try {
      if (!(await workspaceIsUnnamed(workspaceId))) return;
      const apiKey = await getCodexApiKeyFromPiConfig();
      if (!apiKey) logWorkspaceTitleSuggestionError(workspaceId, "openai-codex auth is not configured in pi-config auth.json");
      const response = await completeSimple(model, {
        messages: [{ role: "user", content: promptFor(promptText), timestamp: Date.now() }],
      }, {
        apiKey,
        reasoning: "minimal",
        maxTokens: 32,
      });
      if (response.stopReason === "error") {
        logWorkspaceTitleSuggestionError(workspaceId, response.errorMessage ?? "model returned an error", {
          stopReason: response.stopReason,
          diagnostics: response.diagnostics,
        });
        return;
      }
      const responseText = textFromResponse(response);
      const title = normalizeSlug(responseText);
      if (!title) {
        if (responseText && responseText.toLowerCase() !== "error") {
          logWorkspaceTitleSuggestionError(workspaceId, "model returned an unusable workspace title", { responseText, stopReason: response.stopReason });
        }
        return;
      }
      if (!(await workspaceIsUnnamed(workspaceId))) return;
      await setWorkspaceTitle(workspaceId, title);
      await options.events?.emit("workspace_title_changed", { workspaceId, title });
    } catch (error) {
      logWorkspaceTitleSuggestionError(workspaceId, error instanceof Error ? error.message : String(error), { error });
    } finally {
      pending.delete(workspaceId);
    }
  })();
}
