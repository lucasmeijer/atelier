export {
  addProject,
  onProjectStoreChanged,
  deleteProject,
  formatProjectSpec,
  getProjectConfiguration,
  isGitProjectInit,
  listProjects,
  parseProjectSpec,
  projectsFile,
  projectNameFromGitUrl,
  projectWorkspaceInit,
  updateProject,
  setProjectDockerfile,
  setProjectPreloadImages,
  type AddProjectResult,
  type DeleteProjectResult,
  type GitProjectInitInstruction,
  type ProjectConfiguration,
  type ProjectEnvironmentVariable,
  type ProjectListResult,
  type ProjectSecretSummary,
  type ProjectSshKeySummary,
  type ProjectSummary,
  type UpdateProjectResult,
} from "./project.ts";

export {
  createProjectSshKey,
  deleteProjectSshKey,
  listProjectSshKeys,
  revealProjectSshKeys,
} from "./ssh-keys.ts";

export {
  createProjectEnvironmentVariable,
  deleteProjectEnvironmentVariable,
  listProjectEnvironmentVariables,
  updateProjectEnvironmentVariable,
} from "./environment.ts";

export {
  createProjectSecret,
  deleteProjectSecret,
  listProjectSecrets,
  revealProjectSecrets,
  updateProjectSecret,
  setProjectSecretValue,
  projectSecretValueInputSchema,
  projectSecretRoutingRevision,
  secretNeedsValue,
  projectSecretPlaceholder,
  projectSecretHosts,
  type ProjectSecretInput,
  type ProjectSecretPlaintext,
} from "./secrets.ts";

export {
  clearGitIdentity,
  getGitIdentity,
  getStoredGitIdentity,
  gitIdentitySettingsFile,
  hasGitIdentity,
  registerGitIdentityWorkspaceEvents,
  setGitIdentity,
  type GitIdentitySettings,
} from "./git-identity.ts";

export {
  prepareWorkspaceSource,
  projectDataDirKey,
  registerProjectWorkspaceInitEvents,
  type PreparedWorkspaceSource,
} from "./workspace-source.ts";

export {
  registerProjectWorkspaceEvents,
  type WorkspaceDeleteBlockedDetails,
  type WorkspaceDeleteSafetyIssue,
} from "./workspace-repos.ts";

export { projectWorkspaceSettingsSchema, type ProjectWorkspaceSettings } from "./project.ts";
export { readProjectWorkspaceSettings, writeProjectWorkspaceSettings, projectWorkspaceInitWithSettings, validateProjectWorkspaceSettings } from "./workspace-settings.ts";

export { getProjectSshKnownHosts, setProjectSshKnownHosts } from "./ssh-host-trust.ts";
