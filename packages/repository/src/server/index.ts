import type { WorkspaceModule, WorkspaceRowContributionRegistry } from "@atelier/shared";
import type { AtelierEventBus } from "@atelier/core";
import { listWorkspaces } from "@atelier/workspace";
import { getWorkspaceRepoLineStats, listWorkspaceRepos, registerRepositoryWorkspaceEvents } from "../workspace-repos.ts";

const rowContributionId = "repository.line-stats";
const persistentSystemPromptLine = "The /persistent directory is shared by all workspaces for this repository; use it for files you and the user want to keep across workspaces but not commit to git.";

function renderLineStats(added: number, removed: number): string | undefined {
  if (added === 0 && removed === 0) return undefined;
  const additions = added > 0 ? `<span class="workspace-row-stat workspace-row-stat-add">+${added}</span>` : "";
  const removals = removed > 0 ? `<span class="workspace-row-stat workspace-row-stat-del">-${removed}</span>` : "";
  return `<span class="repository-line-stats" title="Repository line changes">${additions}${removals}</span>`;
}

async function updateLineStats(workspaceId: string, contributions: WorkspaceRowContributionRegistry): Promise<void> {
  try {
    let added = 0;
    let removed = 0;
    const { repos } = await listWorkspaceRepos(workspaceId);
    for (const repo of repos) {
      const stats = await getWorkspaceRepoLineStats(workspaceId, repo);
      added += stats.added;
      removed += stats.removed;
    }
    contributions.set(workspaceId, rowContributionId, renderLineStats(added, removed));
  } catch {
    contributions.set(workspaceId, rowContributionId);
  }
}

export const atelierServerModule: WorkspaceModule = {
  id: "repository",
  initialize(context) {
    const events = context.events as AtelierEventBus;
    registerRepositoryWorkspaceEvents(events);
    events.on("workspace_agent_turn_finished", ({ workspaceId }) => {
      void updateLineStats(workspaceId, context.workspaceRowContributions);
    });
    events.on("agent_system_prompt_prepare", async ({ workspaceId, lines }) => {
      const workspace = (await listWorkspaces()).workspaces.find((entry) => entry.id === workspaceId);
      if (workspace?.sourceRepositoryId) lines.push(persistentSystemPromptLine);
    });
  },
};
