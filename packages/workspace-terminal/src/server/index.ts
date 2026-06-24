export { registerTerminalEvents } from "./events.ts";
export {
  createWorkspaceTerminal,
  deleteWorkspaceTerminal,
  listWorkspaceTerminals,
  type WorkspaceTerminalCreateOptions,
  type WorkspaceTerminalCreateResult,
  type WorkspaceTerminalListResult,
} from "./workspace-terminals.ts";
export {
  domId,
  escapeHtml,
  renderTerminalPane,
  terminalTabKey,
} from "./render.ts";
export {
  renderWorkspaceTerminalTabs,
  terminalWorkspaceModule,
  terminalWorkspaceModule as atelierServerModule,
} from "./web.ts";
export { terminalStaticFiles } from "./static.ts";
export {
  createTerminalSocketHandler,
  type TerminalSocketData,
  type TerminalSocketHandlerOptions,
} from "./sockets.ts";
