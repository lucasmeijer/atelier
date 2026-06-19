import { agentWorkspaceModule } from "@atelier/agent/server";
import { browserWorkspaceModule } from "@atelier/browser/server";
import { desktopWorkspaceModule } from "@atelier/desktop/server";
import { keypressProbeWorkspaceModule } from "@atelier/keypress-probe/server";
import { terminalWorkspaceModule } from "@atelier/workspace-terminal/server";
import { vscodeWorkspaceModule } from "@atelier/vscode/server";
import type { WorkspaceModule } from "@atelier/shared";

export const workspaceModules: WorkspaceModule[] = [
  agentWorkspaceModule,
  terminalWorkspaceModule,
  browserWorkspaceModule,
  desktopWorkspaceModule,
  vscodeWorkspaceModule,
  keypressProbeWorkspaceModule,
];
