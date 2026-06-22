import { atelierClientModule as clientModule0 } from "@atelier/agent/client";
import { atelierClientModule as clientModule1 } from "@atelier/browser/client";
import { atelierClientModule as clientModule2 } from "@atelier/vscode/client";
import { atelierClientModule as clientModule3 } from "@atelier/workspace-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const workspaceClientModules: WorkspaceClientModule[] = [
  clientModule0,
  clientModule1,
  clientModule2,
  clientModule3,
];
