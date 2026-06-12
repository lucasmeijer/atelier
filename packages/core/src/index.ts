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
  addManagedRepo,
  defaultDataDir,
  listManagedRepos,
  managedReposDir,
  type AddManagedRepoResult,
  type ManagedRepoListResult,
  type ManagedRepoSummary,
} from "./managed-repo.ts";

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
  cloneManagedRepoIntoWorkspace,
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
  workspacePreviewPorts,
  workspaceVSCodePort,
  type CreateWorkspaceOptions,
  type DeleteWorkspaceOptions,
  type WorkspaceCloneResult,
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
