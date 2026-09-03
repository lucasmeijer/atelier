interface WorkspaceViewBusyEvent {
  workspaceId: string;
  viewKey: string;
  busy: boolean;
}

type WorkspaceViewBusyListener = (event: WorkspaceViewBusyEvent) => void;

const listeners = new Set<WorkspaceViewBusyListener>();

export function subscribeWorkspaceViewBusy(listener: WorkspaceViewBusyListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishWorkspaceViewBusy(event: WorkspaceViewBusyEvent): void {
  for (const listener of listeners) listener(event);
}
