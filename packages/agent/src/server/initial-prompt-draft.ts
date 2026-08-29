import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atelierDataPath, getAtelierRuntimeContext } from "@atelier/core";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface InitialPromptDraft {
  prompt: string;
  accepted: boolean;
}

const initialPromptDraftSchema = Type.Object({
  prompt: Type.String(),
  accepted: Type.Boolean(),
});

function initialPromptDraftWorkspacePath(workspaceId: string): string {
  return atelierDataPath(getAtelierRuntimeContext(), "agent-initial-prompt-drafts", workspaceId);
}

function initialPromptDraftPath(workspaceId: string, conversationId: string): string {
  return `${initialPromptDraftWorkspacePath(workspaceId)}/${conversationId}.json`;
}

async function persistInitialPromptDraft(workspaceId: string, conversationId: string, draft: InitialPromptDraft): Promise<void> {
  const path = initialPromptDraftPath(workspaceId, conversationId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(draft)}\n`, "utf8");
}

export async function writeInitialPromptDraft(workspaceId: string, conversationId: string, prompt: string): Promise<void> {
  await persistInitialPromptDraft(workspaceId, conversationId, { prompt, accepted: false });
}

export async function readInitialPromptDraft(workspaceId: string, conversationId: string): Promise<InitialPromptDraft | undefined> {
  try {
    return Value.Parse(initialPromptDraftSchema, JSON.parse(await readFile(initialPromptDraftPath(workspaceId, conversationId), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function acceptInitialPromptDraft(workspaceId: string, conversationId: string): Promise<InitialPromptDraft> {
  const draft = await readInitialPromptDraft(workspaceId, conversationId);
  if (!draft) throw new Error(`initial prompt draft not found for Agent ${conversationId} in workspace ${workspaceId}`);
  const accepted = { ...draft, accepted: true };
  await persistInitialPromptDraft(workspaceId, conversationId, accepted);
  return accepted;
}

export async function removeInitialPromptDraft(workspaceId: string, conversationId: string): Promise<void> {
  await rm(initialPromptDraftPath(workspaceId, conversationId), { force: true });
}

export async function removeWorkspaceInitialPromptDrafts(workspaceId: string): Promise<void> {
  await rm(initialPromptDraftWorkspacePath(workspaceId), { recursive: true, force: true });
}
