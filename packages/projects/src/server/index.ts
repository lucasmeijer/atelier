import type { WorkspaceModule, WorkspaceRowContributionRegistry } from "@atelier/shared";
import type { AtelierEventBus } from "@atelier/core";
import { listWorkspaces } from "@atelier/workspace";
import { isGitProjectInit } from "../project.ts";
import { getWorkspaceRepoLineStats, listWorkspaceRepos, registerProjectWorkspaceEvents } from "../workspace-repos.ts";

const rowContributionId = "project.line-stats";
const persistentSystemPromptLine = "The /persistent directory is shared by all workspaces for this project; use it for files you and the user want to keep across workspaces but not commit to git.";

function renderLineStats(added: number, removed: number): string | undefined {
  if (added === 0 && removed === 0) return undefined;
  const net = added - removed;
  const intensity = Math.min(500, Math.abs(net)) / 500;
  const accentPercent = Math.round(intensity * 100);
  const mutedPercent = 100 - accentPercent;
  const tone = net > 0 ? "positive" : net < 0 ? "negative" : "neutral";
  const additions = added > 0 ? `<span class="workspace-row-stat">+${added}</span>` : "";
  const removals = removed > 0 ? `<span class="workspace-row-stat">-${removed}</span>` : "";
  return `<span class="project-line-stats" data-line-stat-tone="${tone}" style="--project-line-stat-muted: ${mutedPercent}%; --project-line-stat-accent: ${accentPercent}%" title="Project line changes">${additions}${removals}</span>`;
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
  id: "projects",
  async initialize(context) {
    const events = context.events as AtelierEventBus;
    registerProjectWorkspaceEvents(events);
    events.on("workspace_agent_turn_finished", ({ workspaceId }) => {
      void updateLineStats(workspaceId, context.workspaceRowContributions);
    });
    events.on("workspace_created", ({ workspaceId }) => {
      void updateLineStats(workspaceId, context.workspaceRowContributions);
    });
    const { workspaces } = await listWorkspaces();
    for (const workspace of workspaces) void updateLineStats(workspace.id, context.workspaceRowContributions);
    events.on("agent_system_prompt_prepare", async ({ workspaceId, lines }) => {
      const workspace = (await listWorkspaces()).workspaces.find((entry) => entry.id === workspaceId);
      if (isGitProjectInit(workspace?.init)) lines.push(persistentSystemPromptLine);
    });
  },
};
