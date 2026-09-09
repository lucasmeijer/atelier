import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspacePresentationStore,
  type WorkspaceWorkViewContribution,
  type WorkspacePresentationStore,
} from "@atelier/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const terminalWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("terminal"),
  terminalId: Type.String(),
  ownership: Type.Union([Type.Literal("owned"), Type.Literal("attached")]),
});

const fileWorkViewReferenceSchema = Type.Object({
  type: Type.Literal("file"),
  path: Type.String(),
});

type TestWorkViewReference = Static<typeof terminalWorkViewReferenceSchema> | Static<typeof fileWorkViewReferenceSchema>;

const terminalWorkViewAdapter: WorkspaceWorkViewContribution<Extract<TestWorkViewReference, { type: "terminal" }>> = {
  type: "terminal",
  parseReference(value) {
    if (!Value.Check(terminalWorkViewReferenceSchema, value)) throw new Error("invalid terminal reference");
    return value;
  },
  identity: (reference) => reference.terminalId,
};
const fileWorkViewAdapter: WorkspaceWorkViewContribution<Extract<TestWorkViewReference, { type: "file" }>> = {
  type: "file",
  parseReference(value) {
    if (!Value.Check(fileWorkViewReferenceSchema, value)) throw new Error("invalid file reference");
    return value;
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

  test("warning dismissals persist by kind and state without changing Work views", async () => {
    expect(await presentation.dismissedWarnings("workspace-1")).toEqual({});
    await presentation.initialize("workspace-1", [{ type: "file", path: "/work/README.md" }]);
    await Promise.all([
      presentation.dismissWarning("workspace-1", "missing-secrets", "state-one"),
      presentation.dismissWarning("workspace-1", "project-settings-changed", "revision-one"),
    ]);
    const restarted = createWorkspacePresentationStore({ dataDir, workViewContributions });
    expect(await restarted.dismissedWarnings("workspace-1")).toEqual({ "missing-secrets": "state-one", "project-settings-changed": "revision-one" });
    await restarted.dismissWarning("workspace-1", "missing-secrets", "state-two");
    expect((await restarted.dismissedWarnings("workspace-1"))["missing-secrets"]).toBe("state-two");
    expect(await restarted.listWorkViews("workspace-1")).toEqual([{ reference: { type: "file", path: "/work/README.md" }, attention: false }]);
  });

  test("dismissal before presentation initialization preserves later initial Work views", async () => {
    await presentation.dismissWarning("workspace-1", "missing-secrets", "state-one");
    const restarted = createWorkspacePresentationStore({ dataDir, workViewContributions });
    await restarted.initialize("workspace-1", [{ type: "file", path: "/work/README.md" }]);
    expect(await restarted.dismissedWarnings("workspace-1")).toEqual({ "missing-secrets": "state-one" });
    expect(await restarted.listWorkViews("workspace-1")).toEqual([{ reference: { type: "file", path: "/work/README.md" }, attention: false }]);
    await restarted.initialize("workspace-1", [{ type: "file", path: "/work/OTHER.md" }]);
    expect(await restarted.listWorkViews("workspace-1")).toHaveLength(1);
    expect((await restarted.listWorkViews("workspace-1"))[0]!.reference).toEqual({ type: "file", path: "/work/README.md" });
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

    const firstAttention = await presentation.requestAttention("workspace-1", terminal);
    expect(await presentation.listWorkViews("workspace-1")).toEqual([
      { reference: terminal, attention: true, attentionSequence: 1 },
      { reference: context, attention: false },
    ]);

    const secondAttention = await presentation.requestAttention("workspace-1", terminal);
    expect(await presentation.acknowledgeAttention("workspace-1", terminal, firstAttention)).toBe(false);
    expect((await presentation.listWorkViews("workspace-1"))[0]?.attentionSequence).toBe(secondAttention);
    expect(await presentation.acknowledgeAttention("workspace-1", terminal, secondAttention)).toBe(true);
    await presentation.requestAttention("workspace-1", terminal);

    expect((await createWorkspacePresentationStore({ dataDir, workViewContributions }).listWorkViews("workspace-1"))[0]).toEqual({
      reference: terminal,
      attention: true,
      attentionSequence: 3,
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
    await expect(presentation.acknowledgeAttention("workspace-1", context, 1)).resolves.toBe(false);
    expect(presentation.reorderWorkView("workspace-1", { type: "file", path: "/work/missing.md" }, 0)).rejects.toMatchObject({ code: "work_view_not_found" });
  });

  test("initialization only writes missing presentation state", async () => {
    const context = { type: "file", path: "/work/CONTEXT.md" } as const;
    await presentation.initialize("workspace-1", [context]);

    await presentation.initialize("workspace-1", [{ type: "file", path: "/work/README.md" }]);

    expect((await presentation.listWorkViews("workspace-1")).map((view) => view.reference)).toEqual([context]);
  });

});
