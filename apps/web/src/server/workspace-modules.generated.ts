import { atelierServerModule as serverModule0 } from "@atelier/agent/server";
import { atelierServerModule as serverModule1 } from "@atelier/browser/server";
import { atelierServerModule as serverModule2 } from "@atelier/desktop/server";
import { atelierServerModule as serverModule3 } from "@atelier/keypress-probe/server";
import { atelierServerModule as serverModule4 } from "@atelier/repository/server";
import { atelierServerModule as serverModule5 } from "@atelier/vscode/server";
import { atelierServerModule as serverModule6 } from "@atelier/workspace-proxy/server";
import { atelierServerModule as serverModule7 } from "@atelier/workspace-terminal/server";
import type { WorkspaceModule } from "@atelier/shared";

export const workspaceModules: WorkspaceModule[] = [
  serverModule0,
  serverModule1,
  serverModule2,
  serverModule3,
  serverModule4,
  serverModule5,
  serverModule6,
  serverModule7,
];
