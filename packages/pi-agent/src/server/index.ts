import { createCliAgentModule } from "@atelier/cli-agent/server";
import { createPiModelRuntime } from "@atelier/llm/server";
import { registerWorkspaceRequestTransform } from "@atelier/proxy-egress/server";
import { providerBrandIconHtml, type WorkspaceModule } from "@atelier/shared";
import { installPiCliConfiguration } from "./pi-cli.ts";
import { createPiCliCredentialTransform } from "./pi-cli-bridge.ts";
import { requirePiModels } from "./auth.ts";
import { piLaunchScript } from "./launch-command.ts";
import { preparePiMcp } from "./mcp.ts";
import { piModelSettings } from "./model-settings.ts";

const cliModule = createCliAgentModule({
  id: "pi", label: "Pi", iconHtml: providerBrandIconHtml("pi", "Pi"),
  requireSetup: requirePiModels,
  settings: piModelSettings,
  prepareWorkspace: installPiCliConfiguration,
  prepareSession: preparePiMcp,
  launchScript: piLaunchScript,
});

export const atelierServerModule: WorkspaceModule = {
  ...cliModule,
  initialize(context) {
    cliModule.initialize!(context);
    registerWorkspaceRequestTransform("pi-cli", createPiCliCredentialTransform(createPiModelRuntime));
  },
};
