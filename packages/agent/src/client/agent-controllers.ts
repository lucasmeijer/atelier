import { createAgentNotificationsController } from "./notifications-controller.ts";
import type { WorkspaceClientModule } from "@atelier/shared";
import { createAgentPaneController, registerAgentPaneVisibilityHooks } from "./agent-pane.ts";
import { createAgentAttachmentsController } from "./attachments-controller.ts";
import { createAgentCompletionsController } from "./completions-controller.ts";
import { createComposerFocusController } from "./composer-focus-controller.ts";
import { createComposerSelectionAutosubmitController } from "./composer-selection-controller.ts";
import { createAgentEditDiffController } from "./edit-diff-controller.ts";
import { createAgentElapsedController } from "./elapsed-controller.ts";
import { createAgentNoticeController } from "./notice-controller.ts";
import { createAgentHtmlPreviewController } from "./html-preview-controller.ts";
import { registerLaunchComposerCommand } from "./launch-composer-command.ts";
import { createAgentMermaidController } from "./mermaid-controller.ts";
import { createAgentProxyController } from "./proxy-controller.ts";
import { createAgentTermController } from "./terminal-controller.ts";
import { createAgentThinkingController } from "./thinking-controller.ts";
import { createAgentLazyDetailController, createAgentTailFrameController } from "./transcript-detail-controllers.ts";

export { agentConnectionShouldRun } from "./agent-pane.ts";
export { agentComposerPrimaryAction, agentComposerTextStorageKey, navigatePromptHistory, PromptHistoryNavigator, type PromptHistoryState } from "./composer-state.ts";
export { agentCompletionRequest, fileCompletionPrefix, insertSlashCommand, type AgentCompletionInput, type AgentCompletionRequest } from "./completion-input.ts";
export { promptTemplateHotkeyConflict } from "./completions-controller.ts";
export { createHtmlAutocompleteController } from "./html-autocomplete-controller.ts";
export { fitHtmlPreview } from "./html-preview-controller.ts";
export { forwardAgentTerminalWheel, terminalOutputHasPrintableText } from "./terminal-controller.ts";

export const agentClientModule: WorkspaceClientModule = {
  id: "agent",
  install({ application, Controller, hooks }) {
    application.register("agent-notifications", createAgentNotificationsController(Controller));
    application.register("agent-pane", createAgentPaneController(Controller));
    application.register("agent-attachments", createAgentAttachmentsController(Controller));
    application.register("composer-focus", createComposerFocusController(Controller));
    application.register("composer-selection-autosubmit", createComposerSelectionAutosubmitController(Controller));
    application.register("agent-elapsed", createAgentElapsedController(Controller));
    application.register("agent-edit-diff", createAgentEditDiffController(Controller));
    application.register("agent-html-preview", createAgentHtmlPreviewController(Controller));
    application.register("agent-thinking", createAgentThinkingController(Controller));
    application.register("agent-tail-frame", createAgentTailFrameController(Controller));
    application.register("agent-lazy-detail", createAgentLazyDetailController(Controller));
    application.register("agent-mermaid", createAgentMermaidController(Controller));
    application.register("agent-notice", createAgentNoticeController(Controller));
    application.register("agent-completions", createAgentCompletionsController(Controller, hooks));
    application.register("agent-proxy", createAgentProxyController(Controller));
    application.register("agent-term", createAgentTermController(Controller));

    registerAgentPaneVisibilityHooks(application, hooks);
    registerLaunchComposerCommand(hooks);
  },
};
