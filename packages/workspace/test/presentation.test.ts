import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspacePresentationStore,
  type WorkspaceWorkViewContribution,
  type WorkspacePresentationStore,
} from "@atelier/workspace";

type TestWorkViewReference =
  | { type: "terminal"; terminalId: string; ownership: "owned" | "attached" }
  | { type: "file"; path: string };

const terminalWorkViewAdapter: WorkspaceWorkViewContribution<Extract<TestWorkViewReference, { type: "terminal" }>> = {
    type: "terminal",
    parseReference(value) {
      const reference = value as Partial<TestWorkViewReference>;
      if (reference.type !== "terminal" || typeof (reference as { terminalId?: unknown }).terminalId !== "string") throw new Error("invalid terminal reference");
      return value as Extract<TestWorkViewReference, { type: "terminal" }>;
    },
    identity: (reference) => reference.terminalId,
  };
const fileWorkViewAdapter: WorkspaceWorkViewContribution<Extract<TestWorkViewReference, { type: "file" }>> = {
    type: "file",
    parseReference(value) {
      const reference = value as Partial<TestWorkViewReference>;
      if (reference.type !== "file" || typeof (reference as { path?: unknown }).path !== "string") throw new Error("invalid file reference");
      return value as Extract<TestWorkViewReference, { type: "file" }>;
    },
    identity: (reference) => reference.path,
  };
const workViewContributions: WorkspaceWorkViewContribution[] = [terminalWorkViewAdapter, fileWorkViewAdapter];

describe("Workspace presentation", () => {
  let dataDir: string;
  let presentation: WorkspacePresentationStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atelier-presentation-"));
    presentation = createWorkspacePresentationStore({ dataDir, workViewContributions });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("persistent Work view state restores after a server restart", async () => {
    await presentation.initialize("workspace-1", [
      { type: "terminal", terminalId: "terminal-1", ownership: "owned" },
      { type: "file", path: "/work/CONTEXT.md" },
    ]);

    const restarted = createWorkspacePresentationStore({ dataDir, workViewContributions });

    expect(await restarted.listWorkViews("workspace-1")).toEqual([
      { reference: { type: "terminal", terminalId: "terminal-1", ownership: "owned" }, attention: false },
      { reference: { type: "file", path: "/work/CONTEXT.md" }, attention: false },
    ]);
  });

  test("opening a Work view deduplicates its typed identity and inserts after the requested view", async () => {
    const terminal = { type: "terminal", terminalId: "terminal-1", ownership: "owned" } as const;
    const context = { type: "file", path: "/work/CONTEXT.md" } as const;
    const readme = { type: "file", path: "/work/README.md" } as const;
    await presentation.initialize("workspace-1", [terminal, readme]);

    expect(await presentation.openWorkView("workspace-1", context, { after: terminal })).toEqual({ opened: true });
    expect(await presentation.openWorkView("workspace-1", { ...context })).toEqual({ opened: false });

    expect((await presentation.listWorkViews("workspace-1")).map((view) => view.reference)).toEqual([terminal, context, readme]);
  });

  test("reordering Work views persists an explicit order", async () => {
    const terminal = { type: "terminal", terminalId: "terminal-1", ownership: "owned" } as const;
    const context = { type: "file", path: "/work/CONTEXT.md" } as const;
    const readme = { type: "file", path: "/work/README.md" } as const;
    await presentation.initialize("workspace-1", [terminal, context, readme]);

    await presentation.reorderWorkView("workspace-1", readme, 0);

    expect((await presentation.listWorkViews("workspace-1")).map((view) => view.reference)).toEqual([readme, terminal, context]);
  });

  test("Attention is persistent, repeatable, acknowledged explicitly, and never reorders Work views", async () => {
    const terminal = { type: "terminal", terminalId: "terminal-1", ownership: "owned" } as const;
    const context = { type: "file", path: "/work/CONTEXT.md" } as const;
    await presentation.initialize("workspace-1", [terminal, context]);

    await presentation.requestAttention("workspace-1", terminal);
    expect(await presentation.listWorkViews("workspace-1")).toEqual([
      { reference: terminal, attention: true, attentionSequence: 1 },
      { reference: context, attention: false },
    ]);

    await presentation.acknowledgeAttention("workspace-1", terminal);
    await presentation.requestAttention("workspace-1", terminal);

    expect((await createWorkspacePresentationStore({ dataDir, workViewContributions }).listWorkViews("workspace-1"))[0]).toEqual({
      reference: terminal,
      attention: true,
      attentionSequence: 2,
    });
  });

  test("closing a Work view removes its persistent state and rejects a second close", async () => {
    const terminal = { type: "terminal", terminalId: "terminal-1", ownership: "owned" } as const;
    const context = { type: "file", path: "/work/CONTEXT.md" } as const;
    await presentation.initialize("workspace-1", [terminal, context]);

    await presentation.closeWorkView("workspace-1", terminal);

    expect(await presentation.listWorkViews("workspace-1")).toEqual([{ reference: context, attention: false }]);
    expect(presentation.closeWorkView("workspace-1", terminal)).rejects.toMatchObject({ code: "work_view_not_found" });
  });

  test("concurrent writes for one Workspace are serialized without losing Work views", async () => {
    await presentation.initialize("workspace-1");
    const files = Array.from({ length: 24 }, (_, index) => ({ type: "file" as const, path: `/work/file-${index}.md` }));

    await Promise.all(files.map((reference) => presentation.openWorkView("workspace-1", reference)));

    expect((await presentation.listWorkViews("workspace-1")).map((view) => view.reference)).toEqual(files);
  });

  test("malformed stored presentation state fails visibly instead of being reinitialized", async () => {
    const metadataDir = join(dataDir, "workspaces", "workspace-1", "metadata");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(join(metadataDir, "presentation.json"), "not json\n");

    expect(presentation.initialize("workspace-1")).rejects.toMatchObject({ code: "workspace_presentation_invalid" });
    expect(await Bun.file(join(metadataDir, "presentation.json")).text()).toBe("not json\n");
  });

  test("inconsistent stored presentation state fails visibly", async () => {
    const metadataDir = join(dataDir, "workspaces", "workspace-1", "metadata");
    const duplicate = { type: "file", path: "/work/CONTEXT.md" };
    await mkdir(metadataDir, { recursive: true });
    await writeFile(join(metadataDir, "presentation.json"), `${JSON.stringify({
      version: 1,
      nextAttentionSequence: 1,
      workViews: [{ reference: duplicate }, { reference: duplicate }],
    })}\n`);

    expect(presentation.listWorkViews("workspace-1")).rejects.toMatchObject({ code: "workspace_presentation_invalid" });
  });

  test("invalid Work view references and transitions fail explicitly", async () => {
    const context = { type: "file", path: "/work/CONTEXT.md" } as const;
    await presentation.initialize("workspace-1", [context]);

    expect(presentation.openWorkView("workspace-1", { type: "unknown" })).rejects.toMatchObject({ code: "work_view_reference_invalid" });
    await expect(presentation.acknowledgeAttention("workspace-1", context)).resolves.toBeUndefined();
    expect(presentation.reorderWorkView("workspace-1", { type: "file", path: "/work/missing.md" }, 0)).rejects.toMatchObject({ code: "work_view_not_found" });
  });

  test("initialization only writes missing presentation state", async () => {
    const context = { type: "file", path: "/work/CONTEXT.md" } as const;
    await presentation.initialize("workspace-1", [context]);

    await presentation.initialize("workspace-1", [{ type: "file", path: "/work/README.md" }]);

    expect((await presentation.listWorkViews("workspace-1")).map((view) => view.reference)).toEqual([context]);
  });

  test("Agent conversation close archives the identified conversation and preserves the last conversation", async () => {
    const archived: string[] = [];
    const conversations = [
      { id: "53fc77b7-dc19-42d5-b200-2e134ec67529", title: "Investigate persistence" },
      { id: "268604ac-d16a-4a4a-ab1e-1ed3ca54687d", title: "Untitled" },
    ];
    const agentPresentation = createWorkspacePresentationStore({
      dataDir,
      workViewContributions,
      agentConversations: async () => conversations.map((conversation) => ({
        ...conversation,
        archive: async () => {
          archived.push(conversation.id);
          conversations.splice(conversations.findIndex((candidate) => candidate.id === conversation.id), 1);
        },
      })),
    });

    expect(await agentPresentation.listAgentConversations("workspace-1")).toEqual(conversations);
    await agentPresentation.closeAgentConversation("workspace-1", conversations[1]!.id);

    expect(archived).toEqual(["268604ac-d16a-4a4a-ab1e-1ed3ca54687d"]);
    expect(agentPresentation.closeAgentConversation("workspace-1", conversations[0]!.id)).rejects.toMatchObject({ code: "last_agent_conversation" });
  });
});
