import type { WorkspaceClientApplication, WorkspaceClientControllerConstructor } from "@atelier/shared";

interface WorkspaceNavigationControllerSurface {
  selectWorkspaceById(workspaceId: string): Promise<void>;
  setActiveWorkspace(workspaceId: string): void;
  showWorkspacePane(): void;
}

interface WorkspaceResidencyControllerSurface {
  selectWorkspace(workspaceId: string, href: string, historyMode?: "push" | "none"): Promise<void>;
  unselectWorkspace(workspaceId: string): void;
  visibleWorkspaceId(): string | undefined;
  oldestPreparedAttentionWorkspaceId(): string | undefined;
}

let application: WorkspaceClientApplication;

export function initializeWorkspaceControllerRegistry(stimulusApplication: WorkspaceClientApplication): void {
  application = stimulusApplication;
}

export function registerWorkspaceControllers(controllers: Record<string, WorkspaceClientControllerConstructor>): void {
  for (const [identifier, controller] of Object.entries(controllers)) application.register(identifier, controller);
}

export function controllerForElement<T>(element: Element, identifier: string): T | null {
  // SAFETY: The server-rendered element and its registered controller establish the requested controller interface.
  return application.getControllerForElementAndIdentifier(element, identifier) as T | null;
}

function workspaceController<T>(identifier: string): T | null {
  const element = document.querySelector<HTMLElement>(`[data-controller~="${identifier}"]`);
  return element ? controllerForElement<T>(element, identifier) : null;
}

export function workspaceNavigationController(): WorkspaceNavigationControllerSurface | null {
  return workspaceController("workspace-navigation");
}

export function residencyController(): WorkspaceResidencyControllerSurface | null {
  return workspaceController("workspace-residency");
}
