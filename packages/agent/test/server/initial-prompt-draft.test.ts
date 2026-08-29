import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptInitialPromptDraft,
  readInitialPromptDraft,
  removeInitialPromptDraft,
  removeWorkspaceInitialPromptDrafts,
  writeInitialPromptDraft,
} from "../../src/server/initial-prompt-draft.ts";
import { renderAgentPane } from "../../src/server/render.ts";

let temporaryDataDir: string | undefined;

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  if (temporaryDataDir) await rm(temporaryDataDir, { recursive: true, force: true });
  temporaryDataDir = undefined;
});

async function useTemporaryDataDir(): Promise<void> {
  temporaryDataDir = await mkdtemp(join(tmpdir(), "atelier-initial-agent-draft-"));
  process.env.ATELIER_DATA_DIR = temporaryDataDir;
}

const emptyPaneState = {
  transcriptHtml: "",
  busy: false,
  stats: { contextPercent: null, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] },
};

describe("initial Agent prompt drafts", () => {
  test("belong to one immutable conversation and survive body reconstruction", async () => {
    await useTemporaryDataDir();
    const workspaceId = "workspace-1";
    const firstId = "53fc77b7-dc19-42d5-b200-2e134ec67529";
    const secondId = "268604ac-d16a-4a4a-ab1e-1ed3ca54687d";
    await writeInitialPromptDraft(workspaceId, firstId, "Configure this project");

    expect(await readInitialPromptDraft(workspaceId, firstId)).toEqual({ prompt: "Configure this project", accepted: false });
    expect(await readInitialPromptDraft(workspaceId, secondId)).toBeUndefined();
    await acceptInitialPromptDraft(workspaceId, firstId);

    const firstAgent = { workspaceId, conversationId: firstId, label: "Agent 1", title: "First", path: "/tmp/first.jsonl" };
    const secondAgent = { workspaceId, conversationId: secondId, label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" };
    const firstRender = await renderAgentPane({ workspaceId, conversationId: firstId }, firstAgent, emptyPaneState);
    const reconstructed = await renderAgentPane({ workspaceId, conversationId: firstId }, firstAgent, emptyPaneState);
    const secondRender = await renderAgentPane({ workspaceId, conversationId: secondId }, secondAgent, emptyPaneState);
    expect(firstRender).toContain("Configure this project");
    expect(reconstructed).toContain("Configure this project");
    expect(secondRender).not.toContain("Configure this project");
  });

  test("removes one conversation draft without consuming its sibling", async () => {
    await useTemporaryDataDir();
    await writeInitialPromptDraft("workspace-1", "agent-a", "A");
    await writeInitialPromptDraft("workspace-1", "agent-b", "B");

    await removeInitialPromptDraft("workspace-1", "agent-a");
    expect(await readInitialPromptDraft("workspace-1", "agent-a")).toBeUndefined();
    expect(await readInitialPromptDraft("workspace-1", "agent-b")).toEqual({ prompt: "B", accepted: false });

    await removeWorkspaceInitialPromptDrafts("workspace-1");
    expect(await readInitialPromptDraft("workspace-1", "agent-b")).toBeUndefined();
  });
});
