import { agentClientModule as clientModule0 } from "@atelier/agent/client";
import { browserClientModule as clientModule1 } from "@atelier/browser/client";
import { keypressProbeClientModule as clientModule2 } from "@atelier/keypress-probe/client";
import { vscodeClientModule as clientModule3 } from "@atelier/vscode/client";
import { workspaceTerminalClientModule as clientModule4 } from "@atelier/workspace-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const workspaceClientModules: WorkspaceClientModule[] = [
  clientModule0,
  clientModule1,
  clientModule2,
  clientModule3,
  clientModule4,
];
