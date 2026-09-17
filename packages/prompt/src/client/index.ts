import type { WorkspaceClientModule } from "@atelier/shared";
import { createAgentAttachmentsController } from "./attachments-controller.ts";
import { createComposerFocusController } from "./composer-focus-controller.ts";
import { createComposerSelectionAutosubmitController } from "./composer-selection-controller.ts";
export const atelierClientModule: WorkspaceClientModule = {
  id: "prompt",
  install({ application, Controller }) {
    application.register("composer-focus", createComposerFocusController(Controller));
    application.register("composer-selection-autosubmit", createComposerSelectionAutosubmitController(Controller));
    application.register("agent-attachments", createAgentAttachmentsController(Controller));
  },
};
