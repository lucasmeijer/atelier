import type { WorkspaceModule } from "@atelier/shared";
import type { AtelierEventBus } from "@atelier/core";
import { ensureAtelierWorkspaceProxy, registerWorkspaceProxyEvents } from "../egress/index.ts";

export const proxyEgressServerModule: WorkspaceModule = {
  id: "proxy-egress",
  async initialize(context) {
    registerWorkspaceProxyEvents(context.events as AtelierEventBus);
    await ensureAtelierWorkspaceProxy();
  },
};

export { proxyEgressServerModule as atelierServerModule };
export {
  clearWorkspaceGitHubToken,
  createWorkspaceSecretContext,
  discoverHostGitHubToken,
  forgetWorkspaceSecretContext,
  getWorkspaceSecretContext,
  hasWorkspaceGitHubToken,
  setWorkspaceGitHubToken,
  type WorkspaceSecretContext,
} from "../secrets/workspace-secrets.ts";
export { HttpRequestBlockedError } from "../secrets/errors.ts";
