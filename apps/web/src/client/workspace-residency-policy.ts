export interface WorkspaceRetentionCandidate {
  workspaceId: string;
  visible: boolean;
  prepared: boolean;
  preparing?: boolean;
  attentionAt?: number;
  lastActivatedAt: number;
  protected?: boolean;
}

function preparedAttentionAt(candidate: WorkspaceRetentionCandidate): number | undefined {
  return candidate.prepared || candidate.preparing ? candidate.attentionAt : undefined;
}

export function retainedWorkspaceIds(candidates: readonly WorkspaceRetentionCandidate[], maximum: number): Set<string> {
  if (maximum < 1) throw new Error("Workspace residency maximum must be positive");
  const ranked = [...candidates].sort((left, right) => {
    const visibleDifference = Number(right.visible) - Number(left.visible);
    if (visibleDifference !== 0) return visibleDifference;
    const protectedDifference = Number(right.protected ?? false) - Number(left.protected ?? false);
    if (protectedDifference !== 0) return protectedDifference;
    const leftAttentionAt = preparedAttentionAt(left);
    const rightAttentionAt = preparedAttentionAt(right);
    if (leftAttentionAt !== undefined && rightAttentionAt !== undefined) return leftAttentionAt - rightAttentionAt || left.workspaceId.localeCompare(right.workspaceId);
    if (leftAttentionAt !== undefined) return -1;
    if (rightAttentionAt !== undefined) return 1;
    return right.lastActivatedAt - left.lastActivatedAt || left.workspaceId.localeCompare(right.workspaceId);
  });
  return new Set(ranked.slice(0, maximum).map((candidate) => candidate.workspaceId));
}

export interface AttentionWorkspace {
  workspaceId: string;
  attentionAt: number;
}

export function oldestAttentionFirst(workspaces: readonly AttentionWorkspace[]): AttentionWorkspace[] {
  return [...workspaces].sort((left, right) => left.attentionAt - right.attentionAt || left.workspaceId.localeCompare(right.workspaceId));
}
