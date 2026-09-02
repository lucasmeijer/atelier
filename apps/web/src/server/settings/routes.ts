import { handleGitHubSettingsRequest } from "./github.ts";
import { handleModelSettingsRequest } from "./models.ts";
import { handleSettingsPageRequest, renderSettingsDialog, type WorkspaceCleanupResult } from "./page.ts";
import { listSettingsContributions } from "./registry.ts";

export { renderSettingsDialog };

export async function handleSettingsRequest(
  request: Request,
  url: URL,
  options: { forceDeleteAllWorkspaces?: () => Promise<WorkspaceCleanupResult> } = {},
): Promise<Response | undefined> {
  const response = await handleSettingsPageRequest(request, url, options)
    ?? await handleGitHubSettingsRequest(request, url)
    ?? await handleModelSettingsRequest(request, url);
  if (response) return response;

  for (const contribution of listSettingsContributions()) {
    const handled = await contribution.handleAction?.({ request, url });
    if (handled) return handled;
  }
  return undefined;
}
