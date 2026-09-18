import { createCliAgentModule } from "@atelier/cli-agent/server";
import { createPiModelRuntime, installSubscriptionCli } from "@atelier/llm/server";
import { providerBrandIconHtml } from "@atelier/shared";
import { requireClaudeSubscription } from "./auth.ts";
import { claudeLaunchScript } from "./launch-command.ts";
import { claudeModelSettings } from "./model-settings.ts";
import { prepareClaudeMcp } from "./mcp.ts";

export const atelierServerModule = createCliAgentModule({
  id: "claude", label: "Claude Code", iconHtml: providerBrandIconHtml("anthropic"),
  requireSetup: requireClaudeSubscription,
  settings: claudeModelSettings,
  prepareWorkspace: async (workspaceId) => installSubscriptionCli(workspaceId, await createPiModelRuntime()),
  prepareSession: prepareClaudeMcp,
  launchScript: claudeLaunchScript,
});
