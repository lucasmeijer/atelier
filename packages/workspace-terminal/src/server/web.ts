import type { WorkspaceCommandContribution, WorkspaceModule, WorkspaceTabContribution } from "@atelier/shared";
import { createWorkspaceTerminal, listWorkspaceTerminals, type WorkspaceTerminalListResult } from "./workspace-terminals.ts";
import { renderTerminalPane } from "./render.ts";
import { terminalTabKey, terminalTitleFromTabKey } from "../shared.ts";
import { terminalStaticFiles } from "./static.ts";
import { registerTerminalEvents, rememberWorkspaceTerminalSignature } from "./events.ts";
import { closeTerminalSocket, handleTerminalSocketMessage, openTerminalSocket, subscribeTerminalTabBusy, validateTerminalSocket } from "./sockets.ts";
import type { AtelierEventBus } from "@atelier/core";

export function renderWorkspaceTerminalTabs(workspaceId: string, terminals: WorkspaceTerminalListResult["terminals"]): WorkspaceTabContribution[] {
  return terminals.map((terminal) => ({
    key: terminalTabKey(terminal.title),
    label: terminal.title,
    paneHtml: renderTerminalPane(workspaceId, terminal.title),
  }));
}

export const terminalWorkspaceCommands: WorkspaceCommandContribution[] = [
  {
    id: "terminal.create",
    label: "New Terminal",
    scope: "workspace",
    surfaces: { ui: { placement: "group-menu" } },
  },
];

export const terminalWorkspaceModule: WorkspaceModule = {
  id: "terminal",
  staticFiles: terminalStaticFiles,
  initialize(context) {
    registerTerminalEvents(context.events as AtelierEventBus);
    context.registerSocketHandler({
      validate: (_request, url) => validateTerminalSocket(url),
      open: (socket) => openTerminalSocket(socket as Parameters<typeof openTerminalSocket>[0]),
      message: (socket, message) => handleTerminalSocketMessage(socket as Parameters<typeof handleTerminalSocketMessage>[0], message as string | Buffer),
      close: (socket) => closeTerminalSocket(socket as Parameters<typeof closeTerminalSocket>[0]),
    });
    subscribeTerminalTabBusy(({ workspaceId, tabKey, busy }) => context.registry.setTabBusy(workspaceId, tabKey, busy));
  },
  commands: [{
    id: "terminal.create",
    async execute({ workspaceId }) {
      return { createdTabKey: terminalTabKey((await createWorkspaceTerminal(workspaceId)).title) };
    },
  }],
  tabs: [{
    owns: (tabKey) => terminalTitleFromTabKey(tabKey) !== undefined,
  }],
  async attachToWorkspace({ workspaceId }) {
    const { terminals } = await listWorkspaceTerminals(workspaceId);
    rememberWorkspaceTerminalSignature(workspaceId, terminals);
    return {
      tabs: renderWorkspaceTerminalTabs(workspaceId, terminals),
      commands: terminalWorkspaceCommands,
    };
  },
};
