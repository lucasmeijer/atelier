import { createWorkspace, type CreateWorkspaceOptions, type WorkspaceNewResult } from "@atelier/workspace";
import { formatRepositorySpec, parseRepositorySpec, repoNameFromUrl, type RepositorySummary } from "./repository.ts";

export interface CreateWorkspaceForRepositoryOptions extends Omit<CreateWorkspaceOptions, "context" | "sourceRepositoryId" | "sourceRepositoryName"> {
  context?: Record<string, unknown>;
  sourceRepositoryId?: string;
  sourceRepositoryName?: string;
}

export async function createWorkspaceForRepository(repository: string | Pick<RepositorySummary, "id" | "name" | "gitUrl" | "branch">, options: CreateWorkspaceForRepositoryOptions = {}): Promise<WorkspaceNewResult> {
  const spec = typeof repository === "string" ? parseRepositorySpec(repository) : { gitUrl: repository.gitUrl, branch: repository.branch };
  const sourceRepositoryId = options.sourceRepositoryId ?? (typeof repository === "string" ? undefined : repository.id);
  const sourceRepositoryName = options.sourceRepositoryName ?? (typeof repository === "string" ? repoNameFromUrl(spec.gitUrl) : repository.name);
  return await createWorkspace({
    ...options,
    sourceRepositoryId,
    sourceRepositoryName,
    context: {
      ...(options.context ?? {}),
      ...(sourceRepositoryId ? { sourceRepositoryId } : {}),
      ...(sourceRepositoryName ? { sourceRepositoryName } : {}),
      gitUrl: spec.gitUrl,
      gitBranch: spec.branch,
      git: { gitUrl: spec.gitUrl, branch: spec.branch, spec: formatRepositorySpec(spec) },
    },
  });
}
