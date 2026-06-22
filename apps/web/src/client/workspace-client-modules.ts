import { agentClientModule } from "@atelier/agent/client";
import { browserClientModule } from "@atelier/browser/client";
import { keypressProbeClientModule } from "@atelier/keypress-probe/client";
import { terminalClientModule } from "@atelier/workspace-terminal/client";
import { vscodeClientModule } from "@atelier/vscode/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const workspaceClientModules: WorkspaceClientModule[] = [
  agentClientModule,
  terminalClientModule,
  browserClientModule,
  vscodeClientModule,
  keypressProbeClientModule,
];
