export {
  addProject,
  deleteProject,
  formatProjectSpec,
  isGitProjectInit,
  listProjects,
  parseProjectSpec,
  projectsFile,
  projectNameFromGitUrl,
  projectWorkspaceInit,
  updateProject,
  setProjectDockerfile,
  type AddProjectResult,
  type DeleteProjectResult,
  type GitProjectInitInstruction,
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
