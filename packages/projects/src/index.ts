export {
  createWorkspaceForProject,
  type CreateWorkspaceForProjectOptions,
} from "./create-workspace.ts";

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
  type AddProjectResult,
  type DeleteProjectResult,
  type GitProjectInitInstruction,
  type ProjectEnvironmentVariable,
  type ProjectListResult,
  type ProjectSecretSummary,
  type ProjectSummary,
  type UpdateProjectResult,
} from "./project.ts";

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
  assertWorkspaceDeleteSafe,
  getWorkspaceRepoSlopometer,
  inspectWorkspaceDeleteSafety,
  listWorkspaceRepos,
  registerProjectWorkspaceEvents,
  type WorkspaceDeleteBlockedDetails,
  type WorkspaceDeleteSafetyIssue,
  type WorkspaceRepoListResult,
  type WorkspaceRepoSlopometer,
} from "./workspace-repos.ts";
