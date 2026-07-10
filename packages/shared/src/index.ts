import { escapeHtml } from "./html.ts";

export { providerBrandColor, providerBrandIconHtml } from "./brand-icons.ts";
export { escapeHtml } from "./html.ts";
export { hopByHopHeaderNames, isHopByHopHeader, stripHopByHopHeaders } from "./proxy-headers.ts";

export const atelierName = "Atelier" as const;

export function domId(...parts: string[]): string {
  return parts.join("_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function encodeWorkspaceFilePath(path: string): string {
  return path.split("/").map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/");
}

export function workspaceProxyUrl(workspaceId: string, appKey: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (appKey === "file") return `/workspaces/${encodeURIComponent(workspaceId)}/files${encodeWorkspaceFilePath(normalizedPath)}`;
  const portMatch = appKey.match(/^port-(\d+)$/)!;
  if (portMatch) return `/workspaces/${encodeURIComponent(workspaceId)}/ports/${portMatch[1]}${normalizedPath}`;
  return `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appKey)}${normalizedPath}`;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  if (!ok) throw new Error("copy command failed");
}

export function looksLikeProjectSpec(value: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(value.trim());
}

export type TurboStreamAction = "append" | "prepend" | "replace" | "update" | "remove";

export function turboStream(action: TurboStreamAction, target: string, html = "", options: { targets?: boolean } = {}): string {
  const targetAttribute = options.targets ? "targets" : "target";
  const targetValue = escapeHtml(target);
  if (action === "remove") return `<turbo-stream action="remove" ${targetAttribute}="${targetValue}"></turbo-stream>`;
  return `<turbo-stream action="${action}" ${targetAttribute}="${targetValue}"><template>${html}</template></turbo-stream>`;
}

export function turboStreamResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/vnd.turbo-stream.html; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(body, { ...init, headers });
}

export interface WorkspaceAttachContext {
  workspaceId: string;
  init?: unknown;
  events?: unknown;
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

export type WorkspaceTabPlacement = "visible-group" | "preview-group";

export interface WorkspaceTabPlacementResult {
  groupId: string;
  moved: boolean;
  createdGroup: boolean;
}

export interface WorkspaceLayoutPlacementController {
  /**
   * Ensure a tab is visible in the preview layout group: the first group without
   * an agent tab, creating a new group when every group has one.
   */
  ensureTabInPreviewGroup(workspaceId: string, tabKeys: string[], tabKey: string): WorkspaceTabPlacementResult | undefined;
}

export interface WorkspaceModuleCommandResult {
  createdTabKey?: string;
  tabPlacement?: WorkspaceTabPlacement;
  streamHtml?: string;
}

export interface WorkspaceModuleCommandContext {
  workspaceId: string;
  events?: unknown;
  tabKeys(): Promise<string[]>;
  layouts: WorkspaceLayoutPlacementController;
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
  transformRequestHeaders?(app: { appKey: string; workspaceId: string }, headers: Headers, target: URL, request: Request): Promise<Headers> | Headers;
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

export interface GlobalSidebarContributionRegistry {
  /** Set server-rendered sidebar HTML for a module contribution; empty/undefined clears it. */
  set(contributionId: string, html?: string): void;
}

export interface SettingsActionContext {
  request: Request;
  url: URL;
}

export interface SettingsContribution {
  id: string;
  label: string;
  icon?: string;
  order?: number;
  render(): Promise<string>;
  handleAction?(context: SettingsActionContext): Promise<Response | undefined>;
}

export interface AgentWorkspaceParameters {
  initialPrompt?: string;
  model?: string;
  thinkingLevel?: string;
  attachmentDraft?: string;
}

export interface AgentWorkspaceCreateRequest extends AgentWorkspaceParameters {
  title?: string;
  seedWithCurrentProjectClone: boolean;
}

export interface AgentWorkspaceForkRequest extends AgentWorkspaceParameters {
  title: string;
}

export interface AgentWorkspaceCreateResult {
  id: string;
  url: string;
  phase: "starting";
}

export interface WorkspaceServerModuleContext {
  events: unknown;
  registry: {
    setTabBusy(workspaceId: string, tabKey: string, busy: boolean): void;
    setTabUnread(workspaceId: string, tabKey: string, unread: boolean): void;
  };
  workspaceRowContributions: WorkspaceRowContributionRegistry;
  globalSidebarContributions: GlobalSidebarContributionRegistry;
  layouts: unknown;
  getTabKeys(workspaceId: string): Promise<string[]>;
  deleteCurrentWorkspace(workspaceId: string, force: boolean): Promise<unknown>;
  createWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceCreateRequest): Promise<AgentWorkspaceCreateResult>;
  forkCurrentWorkspaceFromAgent(workspaceId: string, request: AgentWorkspaceForkRequest): Promise<AgentWorkspaceCreateResult>;
  registerSocketHandler(handler: WorkspaceServerSocketHandler): void;
  registerWorkspaceAppHandler(handler: WorkspaceServerAppHandler): void;
  registerProvisioningHook(hook: WorkspaceServerProvisioningHook): void;
  onWorkspaceRemoved(handler: (workspaceId: string) => void | Promise<void>): void;
}

export interface WorkspaceModule {
  id: string;
  staticFiles?: Record<string, StaticFileContribution>;
  settingsContributions?: SettingsContribution[];
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

export interface WorkspaceClientTabVisibilityContext {
  workspaceId: string;
  tabKey: string;
  group: Element;
  pane: HTMLElement;
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

export interface WorkspacePaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  detail?: string;
  badge?: string;
  keywords?: string[];
  score?: number;
  run(): void | Promise<void>;
}

export interface WorkspacePaletteSearchContext {
  query: string;
  fuzzyScore(candidate: string): number;
}

export interface WorkspacePaletteProvider {
  id: string;
  label: string;
  search(context: WorkspacePaletteSearchContext): WorkspacePaletteItem[] | Promise<WorkspacePaletteItem[]>;
}

export interface WorkspaceClientHooks {
  onBecomeVisible(handler: (context: WorkspaceClientTabVisibilityContext) => void): void;
  onNoLongerVisible(handler: (context: WorkspaceClientTabVisibilityContext) => void): void;
  onFocusGroup(handler: (context: WorkspaceClientFocusContext) => boolean | void | Promise<boolean | void>): void;
  onWorkspaceCommand(handler: (commandId: string) => boolean | void | Promise<boolean | void>): void;
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void;
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void;
  registerPaletteProvider(provider: WorkspacePaletteProvider): void;
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

export {
  CableTopics,
  parseCableIdentifier,
  serializeCableIdentifier,
  type AtelierCableClient,
  type CableClientMessage,
  type CableIdentifier,
  type CableServerMessage,
} from "./cable.ts";
