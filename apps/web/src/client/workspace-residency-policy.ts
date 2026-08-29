export interface WorkspaceRetentionCandidate {
  workspaceId: string;
  visible: boolean;
  prepared: boolean;
  preparing?: boolean;
  unreadAt?: number;
  lastActivatedAt: number;
  protected?: boolean;
}

function preparedUnreadAt(candidate: WorkspaceRetentionCandidate): number | undefined {
  return candidate.prepared || candidate.preparing ? candidate.unreadAt : undefined;
}

export function retainedWorkspaceIds(candidates: readonly WorkspaceRetentionCandidate[], maximum: number): Set<string> {
  if (maximum < 1) throw new Error("Workspace residency maximum must be positive");
  const ranked = [...candidates].sort((left, right) => {
    const visibleDifference = Number(right.visible) - Number(left.visible);
    if (visibleDifference !== 0) return visibleDifference;
    const protectedDifference = Number(right.protected ?? false) - Number(left.protected ?? false);
    if (protectedDifference !== 0) return protectedDifference;
    const leftPreparedUnreadAt = preparedUnreadAt(left);
    const rightPreparedUnreadAt = preparedUnreadAt(right);
    if (leftPreparedUnreadAt !== undefined && rightPreparedUnreadAt !== undefined) return leftPreparedUnreadAt - rightPreparedUnreadAt || left.workspaceId.localeCompare(right.workspaceId);
    if (leftPreparedUnreadAt !== undefined) return -1;
    if (rightPreparedUnreadAt !== undefined) return 1;
    return right.lastActivatedAt - left.lastActivatedAt || left.workspaceId.localeCompare(right.workspaceId);
  });
  return new Set(ranked.slice(0, maximum).map((candidate) => candidate.workspaceId));
}

export interface ReadyWorkspace {
  workspaceId: string;
  unreadAt: number;
}

export function oldestReadyFirst(workspaces: readonly ReadyWorkspace[]): ReadyWorkspace[] {
  return [...workspaces].sort((left, right) => left.unreadAt - right.unreadAt || left.workspaceId.localeCompare(right.workspaceId));
}
