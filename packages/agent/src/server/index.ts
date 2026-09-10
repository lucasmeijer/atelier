export {
  archiveWorkspaceAgentConversation,
  createNextWorkspaceAgentConversation,
  ensureDefaultWorkspaceAgentConversation,
  listWorkspaceAgentConversations,
  parseWorkspaceAgentFilename,
  sessionShareDir,
  workspaceSessionShareKey,
  sessionShareKeySlug,
  sessionShareMountPath,
  setWorkspaceAgentConversationTitle,
  untitledAgentConversationTitle,
  type WorkspaceAgentConversationInfo,
} from "./session-store.ts";
export {
  getWorkspaceAgentRuntime,
  unloadWorkspaceAgentRuntime,
  closeWorkspaceAgentConversation,
  removeWorkspaceAgentRuntimes,
  subscribeWorkspaceViewBusy,
  type AgentLivePresentationSubscription,
  type WorkspaceAgentRuntime,
} from "./runtime.ts";
export { registerAgentEvents } from "./agent-events.ts";
export { handleAgentRequest } from "./routes.ts";
export { workspaceFileEndpoint } from "./workspace-files.ts";
export { resolveWorkspacePortProxyBackend } from "./workspace-proxy.ts";
export { agentConversationKey } from "./render-context.ts";
export { renderAgentPane, renderAgentPaneComposer, renderLaunchComposer, renderLaunchComposerSettings } from "./render-composer.ts";
export { agentWorkspaceModule, agentWorkspaceModule as atelierServerModule, workspaceAgentTabProvider } from "./web.ts";
export { modelRefValue, parseModelRef, prepareNewWorkspaceAgentParameters, rememberNewWorkspaceAgentSettings } from "./model-state.ts";
export {
  createDeleteCurrentWorkspaceTool,
  createWorkspaceAgentTools,
  normalizeWorkspacePath,
  registerWorkspaceAgentTool,
  registerWorkspacePresenter,
  workspaceAgentToolNames,
  type WorkspacePresenterDefinition,
  type WorkspacePresenterDeps,
} from "./tools.ts";
export { agentStaticFiles } from "./static.ts";
export {
  connectModelProviderApiKey,
  ProviderCatalogueRefreshError,
  createPiModelRuntime,
  disconnectModelProvider,
  getConfiguredAgentModels,
  getCustomModelsJson,
  getModelThinkingLevel,
  hasAvailableConfiguredAgentModel,
  loginPiOAuthProvider,
  type PiAuthPrompt,
  setActiveAgentModel,
  setCustomModelsJson,
  setModelThinkingLevel,
  setPickerAgentModels,
  type ConfiguredAgentModel,
  type CustomModelsSaveResult,
} from "./pi-config-models.ts";
export { getPopularModelRank, getPopularProviderRank, getProviderApiKeyExample } from "./hardcoded-provider-knowledge.ts";


export { configureAgentDelegation, resolveAgentConversation, type AgentDelegation, type AgentSessionPreparation, type AgentSessionAttachment, type AgentModelRequestTransform, type AgentDelegationTranscript, type AgentToolPresentation } from "./delegation.ts";
export { ids, type AgentRenderContext } from "./render-context.ts";
export { escapeHtml, turboStream, turboStreamResponse } from "./html.ts";
export { transcriptRow, transcriptActionItemHtml } from "./render-markup.ts";
export { statusHtml } from "./render-tool.ts";
export { assistantTextPhase, isFinalAssistantMessage, finalAssistantText, type TranscriptItem, type TranscriptRecord } from "./transcript.ts";
export { type AgentRouteHandler, requireAgentRuntime } from "./route-support.ts";
export { type AgentTranscriptSnapshot, type AgentTranscriptAddition, type AgentTranscriptAnchor } from "./transcript-contributions.ts";

export { renderNotificationHeader } from "./render-notification.ts";
