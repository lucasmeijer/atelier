import { createWorkspace, type CreateWorkspaceOptions, type WorkspaceNewResult } from "@atelier/workspace";
import { formatRepositorySpec, parseRepositorySpec, type RepositorySummary } from "./repository.ts";

export interface CreateWorkspaceForRepositoryOptions extends Omit<CreateWorkspaceOptions, "context" | "sourceRepositoryId"> {
  context?: Record<string, unknown>;
  sourceRepositoryId?: string;
}

export async function createWorkspaceForRepository(repository: string | Pick<RepositorySummary, "id" | "gitUrl" | "branch">, options: CreateWorkspaceForRepositoryOptions = {}): Promise<WorkspaceNewResult> {
  const spec = typeof repository === "string" ? parseRepositorySpec(repository) : { gitUrl: repository.gitUrl, branch: repository.branch };
  const sourceRepositoryId = options.sourceRepositoryId ?? (typeof repository === "string" ? undefined : repository.id);
  return await createWorkspace({
    ...options,
    sourceRepositoryId,
    context: {
      ...(options.context ?? {}),
      ...(sourceRepositoryId ? { sourceRepositoryId } : {}),
      gitUrl: spec.gitUrl,
      gitBranch: spec.branch,
      git: { gitUrl: spec.gitUrl, branch: spec.branch, spec: formatRepositorySpec(spec) },
    },
  });
}
