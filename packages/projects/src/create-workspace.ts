import { createWorkspace, type CreateWorkspaceOptions, type WorkspaceNewResult } from "@atelier/workspace";
import { parseProjectSpec, projectNameFromGitUrl, projectWorkspaceInit, type ProjectSummary } from "./project.ts";

export interface CreateWorkspaceForProjectOptions extends Omit<CreateWorkspaceOptions, "init"> {
  init?: never;
}

export async function createWorkspaceForProject(project: string | ProjectSummary, options: CreateWorkspaceForProjectOptions = {}): Promise<WorkspaceNewResult> {
  const summary = typeof project === "string"
    ? (() => {
        const spec = parseProjectSpec(project);
        return { id: crypto.randomUUID(), name: projectNameFromGitUrl(spec.gitUrl), gitUrl: spec.gitUrl, branch: spec.branch };
      })()
    : project;
  return await createWorkspace({ ...options, init: projectWorkspaceInit(summary) });
}
