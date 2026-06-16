export {
  createAtelierEventBus,
  type AtelierEventBus,
  type AtelierEventContext,
  type AtelierEventHandler,
  type AtelierEventMap,
  type WorkspaceCreatedEvent,
  type WorkspaceCreationContext,
  type WorkspaceDeleteInspectEvent,
  type WorkspaceDeletedEvent,
  type WorkspaceDockerMount,
  type WorkspaceDockerPlan,
  type WorkspaceImageBuildEvent,
  type WorkspacePlanPrepareEvent,
  type WorkspaceSourcePrepareEvent,
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
  atelierDataPath,
  discoverAtelierRuntimeContext,
  dockerHostAtelierDataPath,
  getAtelierRuntimeContext,
  resetAtelierRuntimeContextForTests,
  type AtelierRuntimeContext,
} from "./runtime-context.ts";

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
  forgetWorkspaceSecretContext,
  getWorkspaceSecretContext,
  type WorkspaceSecretContext,
} from "./secrets/workspace-secrets.ts";

export { HttpRequestBlockedError } from "./secrets/errors.ts";
