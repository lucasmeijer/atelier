import type { WorkspaceModule } from "@atelier/shared";
import type { AtelierEventBus } from "@atelier/core";
import { registerRepositoryWorkspaceEvents } from "../workspace-repos.ts";

export const atelierServerModule: WorkspaceModule = {
  id: "repository",
  initialize(context) {
    registerRepositoryWorkspaceEvents(context.events as AtelierEventBus);
  },
};
