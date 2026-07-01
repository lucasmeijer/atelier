import type { WorkspaceModule, WorkspaceRowContributionRegistry } from "@atelier/shared";
import type { AtelierEventBus } from "@atelier/core";
import { listWorkspaces } from "@atelier/workspace";
import { isGitProjectInit } from "../project.ts";
import { getWorkspaceRepoSlopometer, listWorkspaceRepos, registerProjectWorkspaceEvents } from "../workspace-repos.ts";

const rowContributionId = "project.slopometer";
const persistentSystemPromptLine = "The /persistent directory is shared by all workspaces for this project; use it for files you and the user want to keep across workspaces but not commit to git.";

function formatSignedSlopometerValue(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}
function renderSlopometerStat(text: string, value: number): string {
  const intensity = Math.min(500, Math.abs(value)) / 500;
  const accentPercent = Math.round(intensity * 100);
  const mutedPercent = 100 - accentPercent;
  const tone = value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
  return `<span class="project-slopometer-stat" data-slopometer-tone="${tone}" style="--project-slopometer-stat-muted: ${mutedPercent}%; --project-slopometer-stat-accent: ${accentPercent}%">${text}</span>`;
}
function renderSlopometer(netImplementationLines: number, netTestLines: number): string | undefined {
  if (netImplementationLines === 0 && netTestLines === 0) return undefined;
  const testSlopLines = -netTestLines;
  const implementation = netImplementationLines !== 0 ? renderSlopometerStat(formatSignedSlopometerValue(netImplementationLines), netImplementationLines) : "";
  const tests = testSlopLines !== 0 ? renderSlopometerStat(`t:${formatSignedSlopometerValue(testSlopLines)}`, testSlopLines) : "";
  const title = `This is the slopometer!&#10;&#10;This project has ${formatSignedSlopometerValue(netImplementationLines)} implementation lines, and ${formatSignedSlopometerValue(testSlopLines)} test lines`;
  return `<span class="project-slopometer" title="${title}">${implementation}${tests}</span>`;
}

async function updateSlopometer(workspaceId: string, contributions: WorkspaceRowContributionRegistry): Promise<void> {
  try {
    let netImplementationLines = 0;
    let netTestLines = 0;
    const { repos } = await listWorkspaceRepos(workspaceId);
    for (const repo of repos) {
      const stats = await getWorkspaceRepoSlopometer(workspaceId, repo);
      netImplementationLines += stats.netImplementationLines;
      netTestLines += stats.netTestLines;
    }
    contributions.set(workspaceId, rowContributionId, renderSlopometer(netImplementationLines, netTestLines));
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
      void updateSlopometer(workspaceId, context.workspaceRowContributions);
    });
    events.on("workspace_created", ({ workspaceId }) => {
      void updateSlopometer(workspaceId, context.workspaceRowContributions);
    });
    const { workspaces } = await listWorkspaces();
    for (const workspace of workspaces) void updateSlopometer(workspace.id, context.workspaceRowContributions);
    events.on("agent_system_prompt_prepare", async ({ workspaceId, lines }) => {
      const workspace = (await listWorkspaces()).workspaces.find((entry) => entry.id === workspaceId);
      if (isGitProjectInit(workspace?.init)) lines.push(persistentSystemPromptLine);
    });
  },
};
