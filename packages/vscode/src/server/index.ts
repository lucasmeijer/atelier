export { renderWorkspaceVSCodeTabs, vscodeWorkspaceModule, vscodeWorkspaceModule as atelierServerModule, createWorkspaceVSCodeTab } from "./web.ts";
export { deleteWorkspaceVSCodeTab, ensureWorkspaceVSCodeServer, listWorkspaceVSCodeTabs } from "./workspace-vscode.ts";
export { renderVSCodePane, vscodeTabKey } from "./render.ts";
export { patchVSCodeWorkspaceAppResponse, resolveVSCodeWorkspaceAppTarget, vscodeAppKey, vscodeContainerPort } from "./proxy.ts";
export { vscodeStaticFiles } from "./static.ts";
