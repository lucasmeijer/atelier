import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { listWorkspaceTerminals, type WorkspaceTerminalListResult } from "./workspace-terminals.ts";
import { renderTerminalPane } from "./render.ts";
import { observableTerminalTabPrefix } from "@atelier/observable-terminal/shared";
import { terminalStaticFiles } from "./static.ts";

export function renderWorkspaceTerminalTabs(workspaceId: string, terminals: WorkspaceTerminalListResult["terminals"]): WorkspaceTabContribution[] {
  return terminals.map((terminal) => ({
    key: `${observableTerminalTabPrefix}${terminal.title}`,
    label: terminal.title,
    paneHtml: renderTerminalPane(workspaceId, terminal.title),
  }));
}

export const terminalWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "terminal.create",
    label: "New Terminal",
    surfaces: { ui: { placement: "group-menu" } },
  },
];

export const terminalWorkspaceModule: WorkspaceModule = {
  id: "terminal",
  staticFiles: terminalStaticFiles,
  async attachToWorkspace({ workspaceId }) {
    const { terminals } = await listWorkspaceTerminals(workspaceId);
    return {
      tabs: renderWorkspaceTerminalTabs(workspaceId, terminals),
      workspaceCommands: terminalWorkspaceCommands,
    };
  },
};
