import { createWorkspace, type CreateWorkspaceOptions, type WorkspaceNewResult } from "@atelier/workspace";
import { parseProjectSpec, projectNameFromGitUrl, projectWorkspaceInit, type ProjectSummary } from "./project.ts";

export interface CreateWorkspaceForProjectOptions extends Omit<CreateWorkspaceOptions, "init"> {
  init?: never;
}

export async function createWorkspaceForProject(project: ProjectSummary, options: CreateWorkspaceForProjectOptions = {}): Promise<WorkspaceNewResult> {
  return await createWorkspace({ ...options, init: projectWorkspaceInit(project) });
}

export async function createWorkspaceForProjectSpec(spec: string, options: CreateWorkspaceForProjectOptions = {}): Promise<WorkspaceNewResult> {
  const { gitUrl, branch } = parseProjectSpec(spec);
  const name = projectNameFromGitUrl(gitUrl);
  const project = { id: crypto.randomUUID(), name, gitUrl, branch, sessionShareKey: name };
  return await createWorkspaceForProject(project, options);
}
