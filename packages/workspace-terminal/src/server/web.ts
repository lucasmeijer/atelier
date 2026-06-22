import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { createWorkspaceTerminal, listWorkspaceTerminals, type WorkspaceTerminalListResult } from "./workspace-terminals.ts";
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
  commands: [{
    id: "terminal.create",
    async execute({ workspaceId }) {
      return { createdTabKey: `${observableTerminalTabPrefix}${(await createWorkspaceTerminal(workspaceId)).title}` };
    },
  }],
  tabs: [{
    owns: (tabKey) => tabKey.startsWith(observableTerminalTabPrefix),
  }],
  async attachToWorkspace({ workspaceId }) {
    const { terminals } = await listWorkspaceTerminals(workspaceId);
    return {
      tabs: renderWorkspaceTerminalTabs(workspaceId, terminals),
      workspaceCommands: terminalWorkspaceCommands,
    };
  },
};
