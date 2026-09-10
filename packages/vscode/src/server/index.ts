export { vscodeWorkspaceModule, vscodeWorkspaceModule as atelierServerModule, createWorkspaceVSCodeView, openFileInVSCode } from "./web.ts";
export { deleteWorkspaceVSCodeView, ensureWorkspaceVSCodeServer, listWorkspaceVSCodeViews } from "./workspace-vscode.ts";
export { renderVSCodePane, vscodeViewKey } from "./render.ts";
export { patchVSCodeWorkspaceAppResponse, resolveVSCodeWorkspaceAppBackend, vscodeAppKey, vscodeContainerPort } from "./proxy.ts";
export { vscodeStaticFiles } from "./static.ts";
