export {
  createWorkspaceForProject,
  type CreateWorkspaceForProjectOptions,
} from "./create-workspace.ts";

export {
  addProject,
  formatProjectSpec,
  isGitProjectInit,
  listProjects,
  parseProjectSpec,
  projectsFile,
  projectNameFromGitUrl,
  projectWorkspaceInit,
  type AddProjectResult,
  type GitProjectInitInstruction,
  type ProjectListResult,
  type ProjectSummary,
} from "./project.ts";

export {
  clearGitIdentity,
  getGitIdentity,
  gitIdentitySettingsFile,
  hasGitIdentity,
  registerGitIdentityWorkspaceEvents,
  setGitIdentity,
  type GitIdentitySettings,
} from "./git-identity.ts";

export {
  prepareWorkspaceSource,
  registerProjectWorkspaceInitEvents,
  type PreparedWorkspaceSource,
} from "./workspace-source.ts";

export {
  assertWorkspaceDeleteSafe,
  getWorkspaceRepoLineStats,
  getWorkspaceRepoMergeability,
  inspectWorkspaceDeleteSafety,
  listWorkspaceRepos,
  pushWorkspaceRepo,
  registerProjectWorkspaceEvents,
  type WorkspaceDeleteBlockedDetails,
  type WorkspaceDeleteSafetyIssue,
  type WorkspaceRepoLineStats,
  type WorkspaceRepoListResult,
  type WorkspaceRepoMergeabilityResult,
  type WorkspaceRepoPushResult,
  type WorkspaceRepoWorkingTreeStatus,
} from "./workspace-repos.ts";
