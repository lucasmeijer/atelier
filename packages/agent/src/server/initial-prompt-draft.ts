import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";

const initialPromptDraftSchema = Type.Object({
  prompt: Type.String(),
  accepted: Type.Optional(Type.Boolean()),
});

function initialPromptDraftWorkspacePath(workspaceId: string): string {
  return atelierDataPath(getAtelierRuntimeContext(), "agent-initial-prompt-drafts", workspaceId);
}

function initialPromptDraftPath(workspaceId: string, conversationId: string): string {
  return `${initialPromptDraftWorkspacePath(workspaceId)}/${conversationId}.json`;
}

export async function stageInitialPrompt(workspaceId: string, conversationId: string, prompt: string): Promise<void> {
  const path = initialPromptDraftPath(workspaceId, conversationId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ prompt })}\n`, "utf8");
}

export async function readInitialPromptDraft(workspaceId: string, conversationId: string): Promise<{ prompt: string } | undefined> {
  try {
    const draft = Value.Parse(initialPromptDraftSchema, JSON.parse(await readFile(initialPromptDraftPath(workspaceId, conversationId), "utf8")));
    if (draft.accepted === false) {
      await removeInitialPromptDraft(workspaceId, conversationId);
      return undefined;
    }
    return { prompt: draft.prompt };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function removeInitialPromptDraft(workspaceId: string, conversationId: string): Promise<void> {
  await rm(initialPromptDraftPath(workspaceId, conversationId), { force: true });
}

export async function removeWorkspaceInitialPromptDrafts(workspaceId: string): Promise<void> {
  await rm(initialPromptDraftWorkspacePath(workspaceId), { recursive: true, force: true });
}
