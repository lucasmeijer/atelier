import type { WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { listWorkspaceTerminals, type WorkspaceTerminalListResult } from "./workspace-terminals.ts";
import { renderTerminalPane } from "./render.ts";

export function renderWorkspaceTerminalTabs(workspaceId: string, terminals: WorkspaceTerminalListResult["terminals"]): WorkspaceTabContribution[] {
  return terminals.map((terminal) => ({
    key: `terminal:${terminal.title}`,
    label: terminal.title,
    paneHtml: renderTerminalPane(workspaceId, terminal.title),
  }));
}

export const terminalWorkspaceModule: WorkspaceModule = {
  id: "terminal",
  async attachToWorkspace({ workspaceId }) {
    const { terminals } = await listWorkspaceTerminals(workspaceId);
    return {
      tabs: renderWorkspaceTerminalTabs(workspaceId, terminals),
      tabActions: [{ key: "terminal:create", label: "New Terminal" }],
    };
  },
};
