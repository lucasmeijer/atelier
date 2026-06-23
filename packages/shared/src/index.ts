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

export type WorkspaceCommandScope = "global" | "workspace" | "group" | "tab";

export interface WorkspaceCommandContribution<Input = Record<string, never>> {
  id: string;
  label: string;
  description?: string;
  scope: WorkspaceCommandScope;
  /** Runtime schema placeholder for future typed form/palette generation. */
  inputSchema?: unknown;
  surfaces?: WorkspaceCommandSurfaces;
  /** Type carrier only; command metadata stays serializable. */
  readonly __input?: Input;
}

export interface WorkspaceAttachment {
  tabs?: WorkspaceTabContribution[];
  commands?: WorkspaceCommandContribution[];
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

export interface WorkspaceServerSocketHandler {
  validate?(request: Request, url: URL): Promise<unknown | undefined> | unknown | undefined;
  open?(socket: unknown): void;
  message?(socket: unknown, message: unknown): void;
  close?(socket: unknown): void;
}

export interface WorkspaceServerAppHandler {
  matches(app: { appKey: string; workspaceId: string }): boolean;
  handleRequest?(app: { appKey: string; workspaceId: string }, request: Request, url: URL): Promise<Response | undefined> | Response | undefined;
  resolveTarget?(app: { appKey: string; workspaceId: string }, requestUrl: URL): Promise<URL | undefined> | URL | undefined;
  transformResponse?(app: { appKey: string; workspaceId: string }, response: Response, request: Request): Promise<Response> | Response;
}

export interface WorkspaceServerProvisioningHook {
  id: string;
  label: string;
  parentId?: string;
  run(context: { workspaceId: string; creationContext?: unknown; events?: unknown }): Promise<void> | void;
}

export interface WorkspaceRowContributionRegistry {
  /** Set server-rendered inline HTML for a module contribution; empty/undefined clears it. */
  set(workspaceId: string, contributionId: string, html?: string): void;
}

export interface WorkspaceServerModuleContext {
  events: unknown;
  registry: {
    activeWorkspaceId(): string | undefined;
    setTabBusy(workspaceId: string, tabKey: string, busy: boolean): void;
    setTabUnread(workspaceId: string, tabKey: string, unread: boolean): void;
  };
  workspaceRowContributions: WorkspaceRowContributionRegistry;
  layouts: unknown;
  getTabKeys(workspaceId: string): Promise<string[]>;
  deleteCurrentWorkspace(workspaceId: string, force: boolean): Promise<unknown>;
  registerSocketHandler(handler: WorkspaceServerSocketHandler): void;
  registerWorkspaceAppHandler(handler: WorkspaceServerAppHandler): void;
  registerProvisioningHook(hook: WorkspaceServerProvisioningHook): void;
  onWorkspaceRemoved(handler: (workspaceId: string) => void | Promise<void>): void;
}

export interface WorkspaceModule {
  id: string;
  staticFiles?: Record<string, StaticFileContribution>;
  commands?: WorkspaceModuleCommandHandler[];
  routes?: WorkspaceModuleRouteHandler[];
  tabs?: WorkspaceModuleTabLifecycleHandler[];
  initialize?(context: WorkspaceServerModuleContext): Promise<void> | void;
  attachToWorkspace?(context: WorkspaceAttachContext): Promise<WorkspaceAttachment> | WorkspaceAttachment;
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
