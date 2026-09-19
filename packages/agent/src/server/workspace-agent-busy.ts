interface WorkspaceAgentBusyEvent {
  workspaceId: string;
  agentKey: string;
  busy: boolean;
}

type WorkspaceAgentBusyListener = (event: WorkspaceAgentBusyEvent) => void;

const listeners = new Set<WorkspaceAgentBusyListener>();

export function subscribeWorkspaceAgentBusy(listener: WorkspaceAgentBusyListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishWorkspaceAgentBusy(event: WorkspaceAgentBusyEvent): void {
  for (const listener of listeners) listener(event);
}
