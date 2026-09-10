import { atelierClientModule as clientModule0 } from "@atelier/agent/client";
import { atelierClientModule as clientModule1 } from "@atelier/browser/client";
import { atelierClientModule as clientModule2 } from "@atelier/files/client";
import { atelierClientModule as clientModule3 } from "@atelier/keypress-probe/client";
import { atelierClientModule as clientModule4 } from "@atelier/project-setup/client";
import { atelierClientModule as clientModule5 } from "@atelier/review/client";
import { atelierClientModule as clientModule6 } from "@atelier/subagents/client";
import { atelierClientModule as clientModule7 } from "@atelier/transcription/client";
import { atelierClientModule as clientModule8 } from "@atelier/update/client";
import { atelierClientModule as clientModule9 } from "@atelier/vscode/client";
import { atelierClientModule as clientModule10 } from "@atelier/workspace-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

export const workspaceClientModules: WorkspaceClientModule[] = [
  clientModule0,
  clientModule1,
  clientModule2,
  clientModule3,
  clientModule4,
  clientModule5,
  clientModule6,
  clientModule7,
  clientModule8,
  clientModule9,
  clientModule10,
];
