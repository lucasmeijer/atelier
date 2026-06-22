export { browserStaticFiles } from "./static.ts";
export {
  browserWorkspaceModule,
  browserWorkspaceModule as atelierServerModule,
  browserNavigateEndpoint,
  createWorkspaceBrowserTabForWorkspace,
  deleteWorkspaceBrowserTabForWorkspace,
  renderWorkspaceBrowserTabs,
} from "./web.ts";
export {
  browserAppKey,
  isBrowserWorkspaceApp,
  patchBrowserWorkspaceAppResponse,
  resolveBrowserWorkspaceAppTarget,
} from "./proxy.ts";
export {
  browserFrameId,
  browserTabKey,
  createWorkspaceBrowserTab,
  defaultBrowserAppKey,
  deleteWorkspaceBrowserState,
  deleteWorkspaceBrowserTab,
  getWorkspaceBrowserState,
  listWorkspaceBrowserTabs,
  normalizeBrowserUrl,
  setWorkspaceBrowserTarget,
  type WorkspaceBrowserState,
  type WorkspaceBrowserTab,
} from "./state.ts";
export { renderBrowserFrame, renderBrowserPane, renderBrowserTab } from "./render.ts";
export { createOrOpenPreviewBrowserTool, type CreateOrOpenPreviewBrowserToolDeps, type PreviewBrowserLayoutController } from "./agent-tool.ts";
