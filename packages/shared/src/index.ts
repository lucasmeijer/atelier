import type { AtelierEventBus, JsonObject, JsonValue } from "@atelier/core";
import type { TSchema } from "typebox";
import { escapeHtml } from "./html.ts";

export { providerBrandColor, providerBrandIconHtml } from "./brand-icons.ts";
export { escapeHtml } from "./html.ts";
export { hopByHopHeaderNames, isHopByHopHeader, stripHopByHopHeaders } from "./proxy-headers.ts";

export const atelierName = "Atelier" as const;

export function workspaceFileEditorOpenUrl(workspaceId: string, path: string, position: { line?: number; column?: number } = {}): string {
  const query = new URLSearchParams({ path });
  if (position.line) query.set("line", String(position.line));
  if (position.column) query.set("column", String(position.column));
  return `/workspaces/${encodeURIComponent(workspaceId)}/file-editor/open?${query}`;
}

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
  events?: AtelierEventBus;
}

export interface WorkspaceAgentConversationPresentation {
  id: string;
  title: string;
  sourceKey: string;
  bodyHtml?: string;
}

export interface WorkspaceWorkViewPresentation {
  reference: WorkspaceWorkViewReference;
  sourceKey: string;
  label: string;
  kind: "resource" | "contextual";
  availability?: WorkspaceWorkViewAvailability;
  bodyHtml?: string;
  actionsHtml?: string;
}

export interface WorkspaceWorkViewReference extends JsonObject {
  type: string;
}

export type WorkspaceWorkViewAvailability =
  | { phase: "opening"; detail?: string }
  | { phase: "live" }
  | { phase: "reconnecting"; detail?: string }
  | { phase: "unavailable"; detail: string; recoveryHtml?: string };

export interface WorkspaceModuleWorkViewAdapter<Reference extends WorkspaceWorkViewReference = WorkspaceWorkViewReference> {
  type: Reference["type"];
  parseReference(value: JsonValue): Reference;
  identity(reference: Reference): string;
  close?(context: { workspaceId: string; reference: Reference }): Promise<void> | void;
}

export interface WorkspaceCommandUiSurface {
  /** Where the server-rendered web UI should place this command. */
  placement: "work-launcher" | "agent-action";
  label?: string;
}

export interface WorkspaceCommandShortcutSurface {
  defaultBinding: string;
}

export interface WorkspaceCommandSurfaces {
  ui?: WorkspaceCommandUiSurface;
  shortcut?: WorkspaceCommandShortcutSurface;
}

export type WorkspaceCommandScope = "global" | "workspace" | "agent-conversation" | "work-view";

export interface WorkspaceCommandContribution<Input = Record<string, never>> {
  id: string;
  label: string;
  description?: string;
  scope: WorkspaceCommandScope;
  /** Runtime schema for validation and future typed form/palette generation. */
  inputSchema?: TSchema;
  surfaces?: WorkspaceCommandSurfaces;
  /** Type carrier only; command metadata stays serializable. */
  readonly __input?: Input;
}

export interface WorkspaceAttachment {
  agentConversations?: WorkspaceAgentConversationPresentation[];
  workViews?: WorkspaceWorkViewPresentation[];
  commands?: WorkspaceCommandContribution[];
  overlayHtml?: string[];
}

export interface StaticFileContribution {
  url: URL;
  contentType: string;
}

export interface WorkspaceModuleCommandResult {
  createdAgentConversationId?: string;
  createdWorkView?: WorkspaceWorkViewReference;
  streamHtml?: string;
}

export interface WorkspaceModuleCommandContext<Input = unknown> {
  workspaceId: string;
  events?: AtelierEventBus;
  input: Input;
}

export const emptyWorkspaceCommandInputSchema = { type: "object", additionalProperties: false } as const;

export interface WorkspaceModuleCommandHandler<Input = unknown> {
  id: string;
  /** JSON Schema used to validate automation input and advertise the command in OpenAPI. */
  inputSchema?: TSchema;
  execute(context: WorkspaceModuleCommandContext<Input>): Promise<WorkspaceModuleCommandResult> | WorkspaceModuleCommandResult;
}

export interface WorkspaceModuleRouteContext {
  events?: AtelierEventBus;
  openWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<Response>;
}

export interface WorkspaceModuleRouteHandler {
  handle(request: Request, url: URL, context: WorkspaceModuleRouteContext): Promise<Response | undefined> | Response | undefined;
}


export interface WorkspaceSocketConnection {
  send(message: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface WorkspaceServerSocketSession {
  open?(socket: WorkspaceSocketConnection): void;
  message?(socket: WorkspaceSocketConnection, message: string | Uint8Array): void;
  close?(socket: WorkspaceSocketConnection): void;
}

export type WorkspaceServerSocketHandler = (
  url: URL,
) => Promise<WorkspaceServerSocketSession | undefined> | WorkspaceServerSocketSession | undefined;

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
  run(context: { workspaceId: string; creationContext?: WorkspaceCreationContext; events?: AtelierEventBus }): Promise<void> | void;
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

export interface DeleteCurrentWorkspaceResult {
  deleted: boolean;
  blocked: boolean;
  details?: unknown;
}

export type AgentServiceTier = "default" | "priority";

export interface AgentWorkspaceParameters {
  initialPrompt?: string;
  initialPromptMode?: "send" | "draft";
  model?: string;
  thinkingLevel?: string;
  serviceTier?: AgentServiceTier;
  attachmentDraft?: string;
}

export interface WorkspaceCreationContext extends Record<string, unknown> {
  agent?: AgentWorkspaceParameters;
  fork?: { sourceWorkspaceId: string };
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
  events: AtelierEventBus;
  registry: {
    setViewBusy(workspaceId: string, viewKey: string, busy: boolean): void;
    setViewUnread(workspaceId: string, viewKey: string, unread: boolean): void;
  };
  globalSidebarContributions: GlobalSidebarContributionRegistry;
  presentWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  broadcastWorkspace(workspaceId: string, html: string): void;
  deleteCurrentWorkspace(workspaceId: string, force: boolean): Promise<DeleteCurrentWorkspaceResult>;
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
  workViews?: WorkspaceModuleWorkViewAdapter[];
  initialize?(context: WorkspaceServerModuleContext): Promise<void> | void;
  attachToWorkspace?(context: WorkspaceAttachContext): Promise<WorkspaceAttachment> | WorkspaceAttachment;
}

export interface WorkspaceClientController {
  element: Element;
}

export type WorkspaceClientControllerConstructor = new (...args: never[]) => WorkspaceClientController;

export interface WorkspaceClientApplication {
  register(identifier: string, controllerConstructor: WorkspaceClientControllerConstructor): void;
  getControllerForElementAndIdentifier(element: Element, identifier: string): WorkspaceClientController | null;
}

export interface WorkspaceClientSurfaceVisibilityContext {
  workspaceId: string;
  surfaceKey: string;
  region: Element;
  pane: HTMLElement;
  application: WorkspaceClientApplication;
}

export interface WorkspaceClientFocusContext {
  workspaceId?: string;
  surfaceKey?: string;
  pane?: HTMLElement | null;
  region: HTMLElement;
  application: WorkspaceClientApplication;
}

export const phoneViewportMediaQuery = "(max-width: 700px)";

export function isWorkspacePaneVisible(element: Element): boolean {
  const resident = element.closest(".workspace-detail-resident");
  if (resident && !resident.classList.contains("visible")) return false;
  const presentationPane = element.closest<HTMLElement>("[data-workspace-pane-role][data-workspace-pane-id]");
  if (presentationPane) {
    if (!presentationPane.classList.contains("is-active")) return false;
    const presentation = presentationPane.closest<HTMLElement>(".fixed-workspace-presentation")!;
    if (window.matchMedia(phoneViewportMediaQuery).matches) {
      return presentation.dataset.phoneDestination === `${presentationPane.dataset.workspacePaneRole}:${presentationPane.dataset.workspacePaneId}`;
    }
    return presentationPane.dataset.workspacePaneRole === "agent" || presentation.classList.contains("is-work-pane-open");
  }
  return true;
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

export const recentWorkspaceProjectStorageKey = "atelier:recent-workspace-project-id";

export interface WorkspaceClientCommand {
  id: string;
  label: string;
  description?: string;
  scope: "global" | "workspace" | "agent-conversation" | "work-view";
  binding?: string;
  run(): void | Promise<void>;
}

export interface WorkspaceClientHooks {
  onBecomeVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void;
  onNoLongerVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void;
  onFocusGroup(handler: (context: WorkspaceClientFocusContext) => boolean | void | Promise<boolean | void>): void;
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void;
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void;
  registerPaletteProvider(provider: WorkspacePaletteProvider): void;
  registerCommand(command: WorkspaceClientCommand): void;
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
  decodeCableClientMessage,
  decodeCableServerMessage,
  serializeCableIdentifier,
  type AtelierCableClient,
  type CableClientMessage,
  type CableIdentifier,
  type CableServerMessage,
  type CableSubscriptionOptions,
} from "./cable.ts";
