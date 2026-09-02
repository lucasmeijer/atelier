import { afterEach, expect, test } from "bun:test";
import { createAtelierEventBus, resetAtelierRuntimeContextForTests } from "@atelier/core";
import type { WorkspaceServerModuleContext } from "@atelier/shared";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewWorkspaceModule } from "../src/server/index.ts";
import { createReviewRepository } from "./support/repository.ts";

let dataDir: string | undefined;
const previousDataDir = process.env.ATELIER_DATA_DIR;

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  resetAtelierRuntimeContextForTests();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

test("agent completion broadcasts Review totals before the Review body is hydrated", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-review-events-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  resetAtelierRuntimeContextForTests();

  const workspaceId = "review-events";
  const repository = await createReviewRepository();
  const work = join(dataDir, "workspaces", workspaceId, "work");
  await mkdir(join(dataDir, "workspaces", workspaceId), { recursive: true });
  await rename(repository, work);
  await writeFile(join(work, "changed.ts"), "const after = true;\nconst added = true;\n");

  const events = createAtelierEventBus();
  const broadcasts: string[] = [];
  let workspaceRemoved: ((workspaceId: string) => void | Promise<void>) | undefined;
  const unused = () => { throw new Error("Unexpected Review module context call"); };
  const context: WorkspaceServerModuleContext = {
    events,
    registry: { setViewBusy: unused, markViewAttention: unused },
    globalSidebarContributions: { set: unused },
    presentWorkView: unused,
    broadcastWorkspace(id, html) {
      expect(id).toBe(workspaceId);
      broadcasts.push(html);
    },
    deleteCurrentWorkspace: unused,
    createWorkspaceFromAgent: unused,
    forkCurrentWorkspaceFromAgent: unused,
    registerSocketHandler: unused,
    registerWorkspaceAppResolver: unused,
    registerProvisioningHook: unused,
    onWorkspaceRemoved(handler) { workspaceRemoved = handler; },
  };
  reviewWorkspaceModule.initialize!(context);

  await events.emit("workspace_agent_turn_finished", { workspaceId, conversationId: "agent-1" });

  expect(broadcasts).toHaveLength(1);
  expect(broadcasts[0]).toContain('<turbo-stream action="update" target="work_view_label_review-events_review_workspace"><template>Review <span class="review-additions">+2</span> <span class="review-deletions">−1</span></template></turbo-stream>');
  expect(broadcasts[0]).toContain('action="replace" target="review_review-events_body"');
  const attachment = await reviewWorkspaceModule.attachToWorkspace!({ workspaceId });
  expect(attachment.workViews?.[0]?.labelHtml).toContain("+2");

  await workspaceRemoved?.(workspaceId);
});
