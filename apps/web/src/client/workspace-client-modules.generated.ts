import { agentClientModule as clientModule0 } from "@atelier/agent/client";
import { terminalClientModule as clientModule1 } from "@atelier/workspace-terminal/client";
import { vscodeClientModule as clientModule2 } from "@atelier/vscode/client";
import { browserClientModule as clientModule3 } from "@atelier/browser/client";
import { keypressProbeClientModule as clientModule4 } from "@atelier/keypress-probe/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const workspaceClientModules: WorkspaceClientModule[] = [
  clientModule0,
  clientModule1,
  clientModule2,
  clientModule3,
  clientModule4,
];
