import { createWorkspace, type CreateWorkspaceOptions, type WorkspaceNewResult } from "@atelier/workspace";
import { parseProjectSpec, projectNameFromGitUrl, projectWorkspaceInit, type ProjectSummary } from "./project.ts";

export interface CreateWorkspaceForProjectOptions extends Omit<CreateWorkspaceOptions, "init"> {
  init?: never;
}

export async function createWorkspaceForProject(project: string | ProjectSummary, options: CreateWorkspaceForProjectOptions = {}): Promise<WorkspaceNewResult> {
  const summary = typeof project === "string"
    ? (() => {
        const spec = parseProjectSpec(project);
        const name = projectNameFromGitUrl(spec.gitUrl);
        return { id: crypto.randomUUID(), name, gitUrl: spec.gitUrl, branch: spec.branch, sessionShareKey: name };
      })()
    : project;
  return await createWorkspace({ ...options, init: projectWorkspaceInit(summary) });
}
