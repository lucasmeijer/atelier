import { listWorkspaces } from "@atelier/workspace";
import type { WorkspaceModule } from "@atelier/shared";
import { ensureWorkspaceEgressProxy, registerWorkspaceProxyEvents } from "../egress/index.ts";

export const proxyEgressServerModule: WorkspaceModule = {
  id: "proxy-egress",
  async initialize(context) {
    registerWorkspaceProxyEvents(context.events);
    for (const workspace of (await listWorkspaces({ inspectImages: false })).workspaces) await ensureWorkspaceEgressProxy(workspace.id);
  },
};

export { proxyEgressServerModule as atelierServerModule };
export {
  registerWorkspaceSubscriptionSecrets,
  registerWorkspaceRequestTransform,
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
