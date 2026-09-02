import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAtelierEventBus } from "@atelier/core";
import { createNextWorkspaceAgentConversation, ensureDefaultWorkspaceAgentConversation, listWorkspaceAgentConversations } from "../../src/server/session-store.ts";
import { createWorkspaceAgentTabProvider, workspaceAgentTabProvider } from "../../src/server/web.ts";
import { handleAgentRequest } from "../../src/server/routes.ts";
import { agentAttachmentDraftId, findStagedAttachment, stageAttachment } from "../../src/server/attachment-drafts.ts";
import { readInitialPromptDraft, stageInitialPrompt } from "../../src/server/initial-prompt-draft.ts";
import { getWorkspaceAgentRuntime } from "../../src/server/runtime.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let dir: string | undefined;

async function dataDir(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "atelier-agent-tabs-"));
  process.env.ATELIER_DATA_DIR = dir;
}

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Workspace Agent-tab provider", () => {
  test("keeps listing metadata-only and renders exactly the requested immutable identity", async () => {
    const conversations = [
      { workspaceId: "workspace-1", conversationId: "53fc77b7-dc19-42d5-b200-2e134ec67529", label: "Agent 1", title: "First", path: "/tmp/first.jsonl" },
      { workspaceId: "workspace-1", conversationId: "268604ac-d16a-4a4a-ab1e-1ed3ca54687d", label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" },
    ];
    const rendered: string[] = [];
    const provider = createWorkspaceAgentTabProvider({
      list: async () => conversations,
      render: async (conversation) => {
        rendered.push(conversation.conversationId);
        return `<article>${conversation.title}</article>`;
      },
      dispose: async () => {},
      restore: () => {},
      archive: async () => {},
    });

    expect(await provider.list({ workspaceId: "workspace-1" })).toEqual([
      { id: conversations[0]!.conversationId, title: "First" },
      { id: conversations[1]!.conversationId, title: "Second" },
    ]);
    expect(rendered).toEqual([]);
    expect(await provider.render({ workspaceId: "workspace-1", conversationId: conversations[1]!.conversationId })).toBe("<article>Second</article>");
    expect(rendered).toEqual([conversations[1]!.conversationId]);
    expect(provider.render({ workspaceId: "workspace-1", conversationId: conversations[1]!.label })).rejects.toMatchObject({ code: "agent_conversation_not_found" });
  });

  test("lists shell metadata without labels, paths, or bodies", async () => {
    await dataDir();
    const first = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const second = await createNextWorkspaceAgentConversation("workspace-1");

    expect(await workspaceAgentTabProvider.list({ workspaceId: "workspace-1" })).toEqual([
      { id: first.conversationId, title: "Untitled" },
      { id: second.conversationId, title: "Untitled" },
    ]);
  });

  test("failed archival rolls back the close tombstone so the published conversation remains usable", async () => {
    const conversations = [
      { workspaceId: "workspace-1", conversationId: "53fc77b7-dc19-42d5-b200-2e134ec67529", label: "Agent 1", title: "First", path: "/tmp/first.jsonl" },
      { workspaceId: "workspace-1", conversationId: "268604ac-d16a-4a4a-ab1e-1ed3ca54687d", label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" },
    ];
    const blocked = new Set<string>();
    const provider = createWorkspaceAgentTabProvider({
      list: async () => conversations,
      render: async (conversation) => {
        if (blocked.has(conversation.conversationId)) throw new Error("conversation tombstoned");
        return conversation.title;
      },
      dispose: async (_workspaceId, conversationId) => { blocked.add(conversationId); },
      restore: (_workspaceId, conversationId) => { blocked.delete(conversationId); },
      archive: async () => { throw new Error("archive failed"); },
    });

    await expect(provider.close({ workspaceId: "workspace-1", conversationId: conversations[0]!.conversationId })).rejects.toThrow("archive failed");

    expect(await provider.render({ workspaceId: "workspace-1", conversationId: conversations[0]!.conversationId })).toBe("First");
  });

  test("close waits for runtime disposal before archiving the conversation", async () => {
    const conversations = [
      { workspaceId: "workspace-1", conversationId: "53fc77b7-dc19-42d5-b200-2e134ec67529", label: "Agent 1", title: "First", path: "/tmp/first.jsonl" },
      { workspaceId: "workspace-1", conversationId: "268604ac-d16a-4a4a-ab1e-1ed3ca54687d", label: "Agent 2", title: "Second", path: "/tmp/second.jsonl" },
    ];
    const disposal = deferred();
    const lifecycle: string[] = [];
    const provider = createWorkspaceAgentTabProvider({
      list: async () => conversations,
      render: async (conversation) => conversation.title,
      async dispose() {
        lifecycle.push("dispose:start");
        await disposal.promise;
        lifecycle.push("dispose:end");
      },
      restore: () => {},
      async archive() {
        lifecycle.push("archive");
      },
    });

    const closing = provider.close({ workspaceId: "workspace-1", conversationId: conversations[0]!.conversationId });
    await Bun.sleep(0);
    expect(lifecycle).toEqual(["dispose:start"]);

    disposal.resolve();
    await closing;
    expect(lifecycle).toEqual(["dispose:start", "dispose:end", "archive"]);
  });

  test("serializes concurrent closes so one Agent always remains", async () => {
    await dataDir();
    const first = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const second = await createNextWorkspaceAgentConversation("workspace-1");

    const results = await Promise.allSettled([
      workspaceAgentTabProvider.close({ workspaceId: "workspace-1", conversationId: first.conversationId }),
      workspaceAgentTabProvider.close({ workspaceId: "workspace-1", conversationId: second.conversationId }),
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "last_agent_conversation" } });
    expect((await listWorkspaceAgentConversations("workspace-1")).map(({ conversationId }) => conversationId)).toEqual([second.conversationId]);
  });

  test("Agent file completions reject a display label in place of the immutable conversation id", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${encodeURIComponent(conversation.label)}/completions?q=src`);

    expect(handleAgentRequest(request, new URL(request.url))).rejects.toMatchObject({ code: "agent_conversation_not_found" });
  });

  test("Agent prompt-template expansion resolves the immutable conversation id, not its label", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const request = (identity: string) => new Request(`http://atelier.test/workspaces/workspace-1/agents/${encodeURIComponent(identity)}/completions/prompt-template-expand`, {
      method: "POST",
      body: new URLSearchParams({ text: "Keep this prompt" }),
    });

    const labelRequest = request(conversation.label);
    expect(handleAgentRequest(labelRequest, new URL(labelRequest.url))).rejects.toMatchObject({ code: "agent_conversation_not_found" });

    const conversationRequest = request(conversation.conversationId);
    const response = await handleAgentRequest(conversationRequest, new URL(conversationRequest.url));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/plain");
    expect(await response?.text()).toBe("Keep this prompt");
  });

  test("rejects an empty Agent submission without accepting or clearing the composer", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${conversation.conversationId}/messages`, {
      method: "POST",
      headers: { accept: "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ text: "   ", attachmentDraft: agentAttachmentDraftId("workspace-1", conversation.conversationId) }),
    });

    const response = await handleAgentRequest(request, new URL(request.url));

    expect(response?.status).toBe(422);
    expect(response?.headers.get("x-atelier-attachment-draft-consumed")).toBeNull();
  });

  test("requests parking the current Workspace when /park is submitted", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const events = createAtelierEventBus();
    const parked: string[] = [];
    events.on("workspace_park_requested", ({ workspaceId }) => { parked.push(workspaceId); });
    const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${conversation.conversationId}/messages`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "/park" }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), { events });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      agent: { conversationId: conversation.conversationId, state: "idle" },
      workspace: { id: "workspace-1", parked: true },
    });
    expect(parked).toEqual(["workspace-1"]);
  });

  test("renames the current Agent conversation when /name has a title", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const events = createAtelierEventBus();
    const renamed: string[] = [];
    events.on("workspace_agent_conversation_title_changed", ({ title }) => { renamed.push(title); });
    const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${conversation.conversationId}/messages`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "/name investigate-name-command" }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), { events });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ agent: { conversationId: conversation.conversationId, state: "idle" } });
    expect((await listWorkspaceAgentConversations("workspace-1"))[0]?.title).toBe("investigate-name-command");
    expect(renamed).toEqual(["investigate-name-command"]);
  });

  test("accepts a message with the exact Agent draft and consumes the initial composer text", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const draftId = agentAttachmentDraftId("workspace-1", conversation.conversationId);
    const attachment = await stageAttachment(draftId, new File(["image"], "reference.png", { type: "image/png" }));
    await stageInitialPrompt("workspace-1", conversation.conversationId, "Draft task");
    const submissions: Array<{ text: string; imageCount: number }> = [];
    const runtime = {
      async submit(text: string, options: { images?: unknown[] }): Promise<void> {
        submissions.push({ text, imageCount: options.images?.length ?? 0 });
      },
      userMessages: () => [],
      currentModel: () => undefined,
    };
    const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${conversation.conversationId}/messages`, {
      method: "POST",
      headers: { accept: "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ attachmentDraft: draftId, attachment: attachment.id }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), {
      // SAFETY: This focused route test supplies exactly the runtime methods exercised by message acceptance.
      getRuntime: async () => runtime as never,
    });
    const html = await response?.text();

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-atelier-attachment-draft-consumed")).toBe("true");
    expect(html).toBe("");
    expect(submissions).toEqual([{ text: "", imageCount: 1 }]);
    expect(await readInitialPromptDraft("workspace-1", conversation.conversationId)).toBeUndefined();
    expect(await findStagedAttachment(draftId, attachment.id)).toBeUndefined();
  });

  test("failed prompt preflight retains the durable composer draft and staged attachments", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const draftId = agentAttachmentDraftId("workspace-1", conversation.conversationId);
    const attachment = await stageAttachment(draftId, new File(["image"], "reference.png", { type: "image/png" }));
    await stageInitialPrompt("workspace-1", conversation.conversationId, "Draft task");
    let suggestedTitle = false;
    const runtime = {
      async submit(): Promise<void> {
        throw new Error("model authentication unavailable");
      },
      userMessages: () => [],
      currentModel: () => undefined,
    };
    const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${conversation.conversationId}/messages`, {
      method: "POST",
      headers: { accept: "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ text: "Keep this text", attachmentDraft: draftId, attachment: attachment.id }),
    });

    await expect(handleAgentRequest(request, new URL(request.url), {
      // SAFETY: This focused route test supplies exactly the runtime methods exercised before preflight rejection.
      getRuntime: async () => runtime as never,
      suggestTitleFromPrompt: () => { suggestedTitle = true; },
    })).rejects.toThrow("model authentication unavailable");

    expect(suggestedTitle).toBe(false);
    expect(await readInitialPromptDraft("workspace-1", conversation.conversationId)).toEqual({ prompt: "Draft task" });
    expect(await findStagedAttachment(draftId, attachment.id)).toBeDefined();
  });

  test("rejects attachment drafts owned by another Agent or Workspace without consuming them", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const sibling = await createNextWorkspaceAgentConversation("workspace-1");
    const otherWorkspace = await ensureDefaultWorkspaceAgentConversation("workspace-2");
    const foreignDrafts = [
      agentAttachmentDraftId("workspace-1", sibling.conversationId),
      agentAttachmentDraftId("workspace-2", otherWorkspace.conversationId),
    ];

    for (const [index, draftId] of foreignDrafts.entries()) {
      const attachment = await stageAttachment(draftId, new File([`image-${index}`], `foreign-${index}.png`, { type: "image/png" }));
      const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${conversation.conversationId}/messages`, {
        method: "POST",
        headers: { accept: "text/vnd.turbo-stream.html" },
        body: new URLSearchParams({ attachmentDraft: draftId, attachment: attachment.id }),
      });

      const response = await handleAgentRequest(request, new URL(request.url));

      expect(response?.status).toBe(422);
      expect(response?.headers.get("x-atelier-attachment-draft-consumed")).toBeNull();
      expect(await findStagedAttachment(draftId, attachment.id)).toBeDefined();
    }
  });

  test("keeps JSON message submission compatible without an attachment list", async () => {
    await dataDir();
    const conversation = await ensureDefaultWorkspaceAgentConversation("workspace-1");
    const submissions: string[] = [];
    const runtime = {
      async submit(text: string): Promise<void> {
        submissions.push(text);
      },
      userMessages: () => [],
      currentModel: () => undefined,
    };
    const request = new Request(`http://atelier.test/workspaces/workspace-1/agents/${conversation.conversationId}/messages`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ text: "Keep going" }),
    });

    const response = await handleAgentRequest(request, new URL(request.url), {
      // SAFETY: This focused route test supplies exactly the runtime methods exercised by message acceptance.
      getRuntime: async () => runtime as never,
      suggestTitleFromPrompt: () => {},
    });

    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ agent: { conversationId: conversation.conversationId, state: "running" } });
    expect(submissions).toEqual(["Keep going"]);
  });
});
