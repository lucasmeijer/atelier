import { createPiModelRuntime } from "./pi-config-models.ts";
import { modelSettingsContribution } from "./settings.ts";
import type { WorkspaceModule } from "@atelier/shared";
import { installSubscriptionCli, registerSubscriptionCli } from "./subscription-cli.ts";
export const llmWorkspaceModule: WorkspaceModule = {
  id: "llm",
  settingsContributions: [modelSettingsContribution],
  initialize(context) {
    registerSubscriptionCli(createPiModelRuntime);
    context.registerProvisioningHook({
      id: "workspace.subscription-cli",
      label: "Connect subscription CLIs",
      run: async ({ workspaceId }) => installSubscriptionCli(workspaceId, await createPiModelRuntime()),
    });
  },
};
