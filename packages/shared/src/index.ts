export const atelierName = "Atelier" as const;

export interface WorkspaceAttachContext {
  workspaceId: string;
  sourceRepositoryId?: string | null;
}

export interface WorkspaceTabContribution {
  key: string;
  label: string;
  /** Eager tabs include their pane HTML in the workspace detail response. */
  paneHtml?: string;
}

export interface WorkspaceCommandUiSurface {
  /** Where the server-rendered web UI should place this command. */
  placement: "group-menu";
  label?: string;
}

export interface WorkspaceCommandShortcutSurface {
  defaultBinding: string;
}

export interface WorkspaceCommandSurfaces {
  ui?: WorkspaceCommandUiSurface;
  shortcut?: WorkspaceCommandShortcutSurface;
}

export interface WorkspaceCommandContribution<Input = Record<string, never>> {
  id: string;
  label: string;
  description?: string;
  /** Runtime schema placeholder for future typed form/palette generation. */
  inputSchema?: unknown;
  surfaces?: WorkspaceCommandSurfaces;
  /** Type carrier only; command metadata stays serializable. */
  readonly __input?: Input;
}

export interface WorkspaceAttachment {
  tabs?: WorkspaceTabContribution[];
  workspaceCommands?: WorkspaceCommandContribution[];
  /** Server-rendered per-workspace chrome layered around tab groups. */
  workspaceChromeHtml?: string[];
}

export interface StaticFileContribution {
  url: URL;
  contentType: string;
}

export interface WorkspaceModuleCommandResult {
  createdTabKey?: string;
  streamHtml?: string;
}

export interface WorkspaceModuleCommandContext {
  workspaceId: string;
  events?: unknown;
  tabKeys(): Promise<string[]>;
}

export interface WorkspaceModuleCommandHandler {
  id: string;
  execute(context: WorkspaceModuleCommandContext): Promise<WorkspaceModuleCommandResult> | WorkspaceModuleCommandResult;
}

export interface WorkspaceModuleRouteContext {
  events?: unknown;
}

export interface WorkspaceModuleRouteHandler {
  handle(request: Request, url: URL, context: WorkspaceModuleRouteContext): Promise<Response | undefined> | Response | undefined;
}

export interface WorkspaceModuleTabLifecycleHandler {
  owns(tabKey: string): boolean;
  close?(context: { workspaceId: string; tabKey: string }): Promise<void> | void;
}

export interface WorkspaceModule {
  id: string;
  staticFiles?: Record<string, StaticFileContribution>;
  commands?: WorkspaceModuleCommandHandler[];
  routes?: WorkspaceModuleRouteHandler[];
  tabs?: WorkspaceModuleTabLifecycleHandler[];
  attachToWorkspace(context: WorkspaceAttachContext): Promise<WorkspaceAttachment> | WorkspaceAttachment;
}

export interface WorkspaceClientApplication {
  register(identifier: string, controllerConstructor: unknown): void;
  getControllerForElementAndIdentifier(element: Element, identifier: string): unknown;
}

export type WorkspaceClientControllerConstructor = new (...args: unknown[]) => { element: Element };

export interface WorkspaceClientActivateTabContext {
  workspaceId: string;
  tabKey: string;
  group: Element;
  application: WorkspaceClientApplication;
}

export interface WorkspaceClientFocusContext {
  workspaceId?: string;
  tabKey?: string;
  pane?: HTMLElement | null;
  group: HTMLElement;
  application: WorkspaceClientApplication;
}

export interface WorkspaceClientWorkspaceAppFrameContext {
  appKey: string;
  url: URL;
  frame: HTMLIFrameElement;
}

export interface WorkspaceClientHooks {
  onActivateTab(handler: (context: WorkspaceClientActivateTabContext) => void): void;
  onFocusGroup(handler: (context: WorkspaceClientFocusContext) => boolean | void | Promise<boolean | void>): void;
  onRevealTab(handler: (context: WorkspaceClientActivateTabContext) => void): void;
  onChooseUnreadTab(handler: (tabs: string[]) => string | undefined): void;
  onWorkspaceCommand(handler: (commandId: string) => boolean | void | Promise<boolean | void>): void;
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void;
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void;
}

export interface WorkspaceClientModuleContext {
  application: WorkspaceClientApplication;
  Controller: WorkspaceClientControllerConstructor;
  hooks: WorkspaceClientHooks;
}

export interface WorkspaceClientModule {
  id: string;
  install(context: WorkspaceClientModuleContext): void | Promise<void>;
}
