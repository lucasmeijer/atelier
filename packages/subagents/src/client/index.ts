import type { WorkspaceClientModule } from "@atelier/shared";
import { createCommunicationController } from "./communication-controller.ts";
import { createSubagentsController } from "./subagents-controller.ts";

export const atelierClientModule: WorkspaceClientModule = {
  id: "subagents",
  install({ application, Controller }) {
    application.register("agent-communication", createCommunicationController(Controller));
    application.register("subagents", createSubagentsController(Controller));
  },
};
