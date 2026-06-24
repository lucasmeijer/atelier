export {
  createAtelierEventBus,
  type AtelierEventBus,
  type AtelierEventHandler,
  type AtelierEventMap,
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
  shellQuote,
} from "./shell.ts";

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
  clearWorkspaceGitHubToken,
  createWorkspaceSecretContext,
  discoverHostGitHubToken,
  forgetWorkspaceSecretContext,
  getWorkspaceSecretContext,
  hasWorkspaceGitHubToken,
  setWorkspaceGitHubToken,
  type WorkspaceSecretContext,
} from "./secrets/workspace-secrets.ts";

export { HttpRequestBlockedError } from "./secrets/errors.ts";
