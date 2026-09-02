import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentAttachmentDraftId,
  deliverAttachmentDraft,
  listStagedAttachments,
  moveAttachmentDraft,
  removeStagedAttachments,
  stageAttachment,
  validDraftId,
} from "../../src/server/attachment-drafts.ts";
import { renderAgentPane } from "../../src/server/render-composer.ts";

let dir: string | undefined;

async function dataDir(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "atelier-agent-attachments-"));
  process.env.ATELIER_DATA_DIR = dir;
}

afterEach(async () => {
  delete process.env.ATELIER_DATA_DIR;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Agent attachment drafts", () => {
  test("uses one stable valid draft identity per Workspace conversation", () => {
    const first = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    expect(first).toBe(agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529"));
    expect(first).not.toBe(agentAttachmentDraftId("workspace-1", "268604ac-d16a-4a4a-ab1e-1ed3ca54687d"));
    expect(first).not.toBe(agentAttachmentDraftId("workspace-2", "53fc77b7-dc19-42d5-b200-2e134ec67529"));
    expect(validDraftId(first)).toBe(true);
  });

  test("prepares completed uploads without consuming them", async () => {
    await dataDir();
    const draftId = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    const staged = await stageAttachment(draftId, new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" }));

    const delivered = await deliverAttachmentDraft("workspace-1", draftId, [staged.id]);

    expect(delivered.images).toHaveLength(1);
    expect((await listStagedAttachments(draftId)).map(({ id }) => id)).toEqual([staged.id]);

    const conversationId = "53fc77b7-dc19-42d5-b200-2e134ec67529";
    const html = await renderAgentPane(
      { workspaceId: "workspace-1", conversationId },
      { workspaceId: "workspace-1", conversationId, label: "Agent 1", title: "Untitled", path: "/tmp/session.jsonl" },
      { transcriptHtml: "", busy: false, stats: { contextPercent: null, compactAvailable: false, inputTokens: 0, outputTokens: 0, cost: 0, modelName: undefined, thinkingLevel: "off", thinkingLevels: [], models: [] } },
    );
    expect(html).toContain(`name="attachmentDraft" value="${draftId}"`);
    expect(html).toContain(`name="attachment" value="${staged.id}"`);
    expect(html).toContain("screen.png");
  });

  test("moves launch attachments into the new Agent composer", async () => {
    await dataDir();
    const launchDraftId = crypto.randomUUID();
    const agentDraftId = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    const staged = await stageAttachment(launchDraftId, new File(["draft"], "draft.txt"));

    await moveAttachmentDraft(launchDraftId, agentDraftId);

    expect(await listStagedAttachments(launchDraftId)).toEqual([]);
    expect((await listStagedAttachments(agentDraftId)).map(({ id, name }) => ({ id, name }))).toEqual([{ id: staged.id, name: "draft.txt" }]);
  });

  test("consumes only the submitted attachments and preserves concurrent uploads", async () => {
    await dataDir();
    const draftId = agentAttachmentDraftId("workspace-1", "53fc77b7-dc19-42d5-b200-2e134ec67529");
    const submitted = await stageAttachment(draftId, new File(["first"], "first.png", { type: "image/png" }));
    const concurrent = await stageAttachment(draftId, new File(["second"], "second.png", { type: "image/png" }));

    await deliverAttachmentDraft("workspace-1", draftId, [submitted.id]);
    await removeStagedAttachments(draftId, [submitted.id]);

    expect((await listStagedAttachments(draftId)).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: concurrent.id, name: "second.png" },
    ]);
  });
});
