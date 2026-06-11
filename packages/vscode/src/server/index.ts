export { renderWorkspaceVSCodeTabs, vscodeWorkspaceModule, createWorkspaceVSCodeTab } from "./web.ts";
export { deleteWorkspaceVSCodeTab, ensureWorkspaceVSCodeServer, listWorkspaceVSCodeTabs } from "./workspace-vscode.ts";
export { renderVSCodePane, vscodeTabKey } from "./render.ts";
export { parseWorkspaceAppHost, proxyWorkspaceAppRequest, vscodeAppKey, vscodeContainerPort, workspaceAppWebSocketTarget, type WorkspaceAppHost } from "./proxy.ts";
export { vscodeStaticFiles } from "./static.ts";
