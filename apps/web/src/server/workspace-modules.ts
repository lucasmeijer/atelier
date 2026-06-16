import { agentWorkspaceModule } from "@atelier/agent/server";
import { browserWorkspaceModule } from "@atelier/browser/server";
import { terminalWorkspaceModule } from "@atelier/workspace-terminal/server";
import { vscodeWorkspaceModule } from "@atelier/vscode/server";
import type { WorkspaceModule } from "@atelier/shared";

export const workspaceModules: WorkspaceModule[] = [
  agentWorkspaceModule,
  terminalWorkspaceModule,
  browserWorkspaceModule,
  vscodeWorkspaceModule,
];
