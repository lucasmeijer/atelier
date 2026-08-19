import type { WorkspaceModule } from "@atelier/shared";
import { listWorkspaces } from "@atelier/workspace";
import { isGitProjectInit } from "../project.ts";
import { registerProjectSshAgentWorkspaceEvents, restoreProjectSshAgents } from "../ssh-agent.ts";
import { registerProjectWorkspaceEvents } from "../workspace-repos.ts";

const persistentSystemPromptLine = "The /persistent directory is shared by all workspaces for this project; use it for files you and the user want to keep across workspaces but not commit to git.";

export const atelierServerModule: WorkspaceModule = {
  id: "projects",
  async initialize(context) {
    const { events } = context;
    registerProjectWorkspaceEvents(events);
    registerProjectSshAgentWorkspaceEvents(events);
    await restoreProjectSshAgents();
    events.on("agent_system_prompt_prepare", async ({ workspaceId, lines }) => {
      const workspace = (await listWorkspaces()).workspaces.find((entry) => entry.id === workspaceId);
      if (isGitProjectInit(workspace?.init)) lines.push(persistentSystemPromptLine);
    });
  },
};
