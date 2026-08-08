export {
  createAtelierEventBus,
  type AtelierEventBus,
  type AtelierEventHandler,
  type AtelierEventMap,
  type AgentSystemPromptPrepareEvent,
} from "./events.ts";

export {
  requireDocker,
  runDocker,
  runDockerBuffer,
  type CommandBufferResult,
  type CommandInput,
  type CommandResult,
} from "./docker.ts";

export {
  AtelierCoreError,
  invalidArguments,
  type AtelierError,
} from "./errors.ts";

export {
  readJsonObject,
  requestAcceptsJson,
} from "./json-request.ts";

export {
  defaultDataDir,
} from "./data-dir.ts";

export {
  acquireFileLock,
  createProcessFileLock,
} from "./file-lock.ts";

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
  clearWorkspaceGitHubToken,
  discoverHostGitHubToken,
  gitHubCredentialHelperCommand,
  gitHubCredentialHelperShellBody,
  hasWorkspaceGitHubToken,
  setWorkspaceGitHubToken,
} from "./github-token.ts";
