import { prepareCodexMcp } from "./mcp.ts";
import { createCliAgentModule } from "@atelier/cli-agent/server";
import { createPiModelRuntime, installSubscriptionCli } from "@atelier/llm/server";
import { providerBrandIconHtml } from "@atelier/shared";
import { requireCodexSubscription } from "./auth.ts";
import { codexLaunchScript } from "./launch-command.ts";
import { codexModelSettings } from "./model-settings.ts";

export const atelierServerModule = createCliAgentModule({
  id: "codex", label: "Codex", iconHtml: providerBrandIconHtml("openai"),
  requireSetup: requireCodexSubscription,
  settings: codexModelSettings,
  prepareWorkspace: async (workspaceId) => installSubscriptionCli(workspaceId, await createPiModelRuntime()),
  prepareSession: prepareCodexMcp,
  launchScript: codexLaunchScript,
});
