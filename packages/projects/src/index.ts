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
  type AddProjectResult,
  type DeleteProjectResult,
  type GitProjectInitInstruction,
  type ProjectListResult,
  type ProjectSummary,
} from "./project.ts";

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
  getWorkspaceRepoLineStats,
  inspectWorkspaceDeleteSafety,
  listWorkspaceRepos,
  registerProjectWorkspaceEvents,
  type WorkspaceDeleteBlockedDetails,
  type WorkspaceDeleteSafetyIssue,
  type WorkspaceRepoLineStats,
  type WorkspaceRepoListResult,
} from "./workspace-repos.ts";
