export const atelierName = "Atelier" as const;

export interface WorkspaceAttachContext {
  workspaceId: string;
}

export interface WorkspaceTabContribution {
  key: string;
  tabHtml: string;
  /** Eager tabs include their pane HTML in the workspace detail response. */
  paneHtml?: string;
  /** Lazy tabs can point at a server-rendered pane endpoint fetched on first activation. */
  paneUrl?: string;
}

export interface WorkspaceTabActionContribution {
  key: string;
  html: string;
}

export interface WorkspaceAttachment {
  tabs?: WorkspaceTabContribution[];
  tabActions?: WorkspaceTabActionContribution[];
}

export interface WorkspaceModule {
  id: string;
  attachToWorkspace(context: WorkspaceAttachContext): Promise<WorkspaceAttachment> | WorkspaceAttachment;
}
