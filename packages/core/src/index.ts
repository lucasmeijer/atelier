export {
  createAtelierEventBus,
  type AtelierEventBus,
  type AtelierEventContext,
  type AtelierEventHandler,
  type AtelierEventMap,
  type WorkspaceCreatedEvent,
  type WorkspaceCreationContext,
  type WorkspaceImageBuildEvent,
  type WorkspaceTitleChangedEvent,
  type WorkspaceUserActivityEvent,
} from "./events.ts";

export {
  requireDocker,
  runDocker,
  type CommandResult,
} from "./docker.ts";

export {
  AtelierCoreError,
  invalidArguments,
  type AtelierError,
} from "./errors.ts";

export {
  defaultDataDir,
} from "./data-dir.ts";

export {
  addRepository,
  formatRepositorySpec,
  listRepositories,
  parseRepositorySpec,
  repositoriesFile,
  type AddRepositoryResult,
  type RepositoryListResult,
  type RepositorySummary,
} from "./repository.ts";

export {
  atelierDataPath,
  discoverAtelierRuntimeContext,
  dockerHostAtelierDataPath,
  getAtelierRuntimeContext,
  resetAtelierRuntimeContextForTests,
  type AtelierRuntimeContext,
} from "./runtime-context.ts";

export { resolveWorkspaceImage } from "./workspace-image.ts";

export {
  createHttpHooks,
  makeDefaultSecretPlaceholder,
  type CreateHttpHooksOptions,
  type SecretDefinition,
  type SecretManager,
} from "./secrets/placeholder-hooks.ts";

export {
  createWorkspaceSecretContext,
  discoverHostGitHubToken,
  getWorkspaceSecretContext,
  type WorkspaceSecretContext,
} from "./secrets/workspace-secrets.ts";

export {
  atelierWorkspaceProxyPort,
  ensureAtelierWorkspaceProxy,
  stopAtelierWorkspaceProxy,
} from "./proxy/egress-proxy.ts";

export {
  createWorkspace,
  deleteWorkspace,
  generateWorkspaceId,
  workspaceContainerName,
  execWorkspace,
  execWorkspaceCommand,
  execWorkspaceShell,
  inspectWorkspaceDeleteSafety,
  getWorkspacePreviewPort,
  getWorkspacePublishedPort,
  getWorkspaceRepoMergeability,
  getWorkspaceVSCodePort,
  listWorkspaces,
  listWorkspaceRepos,
  pushWorkspaceRepo,
  setWorkspaceTitle,
  workspaceCommand,
  workspaceRoot,
  workspacePreviewPorts,
  workspaceVSCodePort,
  type CreateWorkspaceOptions,
  type DeleteWorkspaceOptions,
  type WorkspaceCommandContext,
  type WorkspaceCommandOptions,
  type WorkspaceDeleteBlockedDetails,
  type WorkspaceDeleteSafetyIssue,
  type WorkspaceExecResult,
  type WorkspaceListResult,
  type WorkspaceNewResult,
  type WorkspaceRepoListResult,
  type WorkspaceRepoMergeabilityResult,
  type WorkspaceRepoPushResult,
  type WorkspaceRepoWorkingTreeStatus,
} from "./workspace.ts";
