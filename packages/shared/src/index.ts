export const atelierName = "Atelier" as const;

export interface WorkspaceAttachContext {
  workspaceId: string;
}

export interface WorkspaceTabContribution {
  key: string;
  label: string;
  /** Eager tabs include their pane HTML in the workspace detail response. */
  paneHtml?: string;
}

export interface WorkspaceTabActionContribution {
  key: string;
  label: string;
}

export interface WorkspaceAttachment {
  tabs?: WorkspaceTabContribution[];
  tabActions?: WorkspaceTabActionContribution[];
}

export interface StaticFileContribution {
  url: URL;
  contentType: string;
}

export interface WorkspaceModule {
  id: string;
  staticFiles?: Record<string, StaticFileContribution>;
  attachToWorkspace(context: WorkspaceAttachContext): Promise<WorkspaceAttachment> | WorkspaceAttachment;
}
