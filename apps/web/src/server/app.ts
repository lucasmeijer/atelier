import {
  maybeNameWorkspaceFromPrompt,
  projectOnboardingInitialPrompt,
  type OnboardingToolDependencies,
} from "@atelier/agent/server";
import {
  AtelierCoreError,
  createKeyedOperationQueue,
  invalidArguments,
  isJsonObject,
  readJsonObject,
  requestAcceptsJson,
  type AtelierEventBus,
  type JsonObject,
  type JsonValue,
} from "@atelier/core";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { warningBannerHtml } from "@atelier/design-system/warning-banner";
import { parseModelRef } from "@atelier/llm/server";
import { getProjectConfiguration, isGitProjectInit, isSshAuthenticationFailure, listProjects, projectWorkspaceInit, projectWorkspaceInitWithSettings, readProjectWorkspaceSettings, type ProjectConfiguration, type ProjectSummary } from "@atelier/projects";
import { validDraftId } from "@atelier/prompt/server";
import {
  domId,
  emptyWorkspaceCommandInputSchema,
  escapeHtml,
  parseWorkspaceFileTarget,
  turboStreamResponse,
  workspaceModuleModalFrameId,
  type CableIdentifier,
  type DeleteCurrentWorkspaceResult,
  type GlobalSidebarContributionRegistry,
  type LiveRegion,
  type WorkspaceAttachment,
  type WorkspaceCommandContribution,
  type WorkspaceDeletionReview,
  type WorkspaceModuleCommandHandler,
  type WorkspaceModuleCommandResult,
  type WorkspaceModuleRouteHandler,
  type WorkspaceModuleWorkViewAdapter,
  type WorkspaceWorkViewPresentation
} from "@atelier/shared";
import { createWorkspacePresentationStore, createWorkspaceProvisioning, generateWorkspaceId, listWorkspaces, setWorkspaceParked, setWorkspaceTitle, type WorkspaceCreationContext, type WorkspaceInitInstruction, type WorkspaceProvisioning, type WorkspaceProvisionRun, type WorkspaceWorkViewReference, type WorkspaceWorkViewState } from "@atelier/workspace";
import { renderWorkspaceLaunchPrompt, renderWorkspaceProvisioning } from "@atelier/workspace/server/provisioning";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAgentPaneHost } from "./agent-pane-host.ts";
import { agentContentId, selectAgentTurboStream } from "./agent-pane.ts";
import { agentProvider, defaultAgentProvider, orderedAgentProviders, registeredAgentProviders, rememberAgentProvider } from "./agent-providers.ts";
import { openWorkspaceFile } from "./file-navigation.ts";
import { httpErrorStatus, jsonResponse, problemJsonResponse, response, turboReplaceStream, turboUpdateStream, wantsTurboStream } from "./http-responses.ts";
import { launchComposerContent, renderLaunchComposer, renderLaunchProvider } from "./launch-composer.ts";
import { createLiveResource } from "./live-resource.ts";
import { handleOnboardingRequest, renderOnboardingDialog } from "./onboarding/routes.ts";
import { atelierOpenApi } from "./openapi.ts";
import { createPageLayout } from "./page-layout.ts";
import { createProjectRoutes, type ProjectEditorModalOptions } from "./project-routes.ts";
import { handleSettingsRequest, renderDevelopmentSettingsDialog, renderSettingsDialog } from "./settings/routes.ts";
import { parseCloseWorkViewRequest, parseReorderWorkViewRequest } from "./work-view-api.ts";
import { createWorkspaceDeletion } from "./workspace-deletion.ts";
import { workspaceModules } from "./workspace-modules.ts";
import { dismissWorkspaceParkConfirmationTurboStream, presentWorkViewTurboStream, renderAtelierBar, renderMobileWorkspaceBar, renderWorkspaceDeletionPresentation, renderWorkspacePane, renderWorkspaceParkConfirmation, renderWorkspacePresentation, workspacePaneCollectionsRegions, workspacePaneOnboardingState, workContentId, type WorkspacePresentation as FixedWorkspacePresentation, type WorkPaneContribution, type WorkspacePanePresentation, type WorkspacePaneProject } from "./workspace-presentation.ts";
import type { WorkspaceDeletionState, WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceWarnings, type WorkspaceWarning } from "./workspace-warnings.ts";

const jsonStringSchema = Type.String();
export interface WebAppDeps {
  registry: WorkspaceRegistry;
  /** Event bus passed through to the agent module routes. */
  events?: AtelierEventBus;
  devReload?: boolean;
  /** Create the container + default agent etc. for an already-registered workspace id. */
  provisionWorkspace(id: string, options: { init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; run: WorkspaceProvisionRun }): Promise<void>;
  /** Test/embedding override. Production obtains this contribution from the Review module. */
  deletionReview?: WorkspaceDeletionReview;
  /** Force-remove the workspace container. */
  destroyWorkspace(id: string): Promise<void>;
  /** Persist parked state and stop or start its workspace container. Defaults to setWorkspaceParked. */
  persistWorkspaceParked?(id: string, parked: boolean): Promise<void>;
  /** Receives background task failures. Defaults to console.error. */
  logError?(message: string): void;
  workspaceRemovedHandlers?: Array<(workspaceId: string) => void | Promise<void>>;
}

export interface WebApp {
  fetch(request: Request): Promise<Response>;
  invalidateWorkspace(workspaceId: string): void;
  subscribeShell(listener: (html: string) => void): Promise<import("@atelier/shared").CableChannelSubscription>;
  subscribeSurface(identifier: CableIdentifier, listener: (html: string) => void): Promise<import("@atelier/shared").CableChannelSubscription>;
  deleteCurrentWorkspaceFromAgent(workspaceId: string, force: boolean): Promise<DeleteCurrentWorkspaceResult>;
  resumeWorkspaceDeletions(): void;
  provisioning: WorkspaceProvisioning;
  createWorkspaceFromAgent: OnboardingToolDependencies["createWorkspace"];
  createWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  presentWorkViewFromAgent(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
  globalSidebarContributions: GlobalSidebarContributionRegistry;
}

type WorkspaceCommandResponse = { id: string; workView?: WorkspaceWorkViewReference; agentConversationId?: string };

function selectWorkspaceTurboStream(workspaceId: string): string {
  return `<turbo-stream action="select-workspace" target="workspace_detail" data-workspace-id="${escapeHtml(workspaceId)}"></turbo-stream>`;
}

export function createWebApp(deps: WebAppDeps): WebApp {
  const { registry } = deps;
  const logError = deps.logError ?? ((message: string) => console.error(message));
  // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
  const workViewAdapters = workspaceModules.flatMap((module) => module.workViews ?? []) as WorkspaceModuleWorkViewAdapter[];
  const moduleDeletionReviews = workspaceModules.flatMap((module) => module.deletionReview ? [module.deletionReview] : []);
  if (!deps.deletionReview && moduleDeletionReviews.length !== 1) throw new Error(`Expected one deletion Review contribution, found ${moduleDeletionReviews.length}`);
  const deletionReview = deps.deletionReview ?? moduleDeletionReviews[0]!;
  const deletion = createWorkspaceDeletion({
    registry,
    inspect: (id) => deletionReview.inspect(id),
    destroy: deps.destroyWorkspace,
    cancelPreparation: (id) => provisioning.cancel(id),
    changed: invalidatePresentation,
  });
  const agentProviders = registeredAgentProviders();
  const agentTabs = createAgentPaneHost(agentProviders);
  const presentationStore = createWorkspacePresentationStore({
    workViewContributions: workViewAdapters,
  });
  const serializePresentationMutation = createKeyedOperationQueue();

  const workPresentationIntents = new Map<string, { key: string; revision: string }>();
  type SurfaceState = { kind: "workspace"; presentation: FixedWorkspacePresentation }
    | { kind: "regions"; regions: readonly LiveRegion[] };
  const surfaces = new Map<string, { workspaceId: string; kind: string; resource: ReturnType<typeof createLiveResource<SurfaceState>> }>();
  const reportPresentationError = (error: Error) => logError(
    `Could not refresh live state: ${error instanceof Error ? error.message : String(error)}`,
  );
  const shell = createLiveResource(async () => {
    const pane = await workspacePaneCollections("");
    return [...workspacePaneCollectionsRegions(pane), ...[...globalRegions.values()].flat(),
      { target: "global_sidebar_contributions", html: renderGlobalSidebarContributions() },
      { target: "workspace_residents", html: workspaceMounts() },
      { target: emptyWorkspaceOnboardingId, html: emptyWorkspaceOnboardingHtml(pane), action: "replace" as const },
    ];
  }, regions => regions, reportPresentationError);

  function invalidatePresentation(): void {
    shell.invalidate();
    for (const { kind, resource } of surfaces.values()) if (kind === "workspace") resource.invalidate();
  }

  function invalidateWorkspace(workspaceId?: string): void {
    invalidatePresentation();
    for (const surface of surfaces.values()) {
      if (surface.kind !== "workspace" && surface.workspaceId === workspaceId) surface.resource.invalidate();
    }
  }

  function surfaceFor(identifier: CableIdentifier) {
    if (identifier.channel !== "module" || identifier.name !== "surface") throw new Error("Invalid surface channel");
    const { workspaceId, params } = identifier;
    requireWorkspace(workspaceId);
    const { kind, key = "" } = params;
    const contributed = workspaceModules.flatMap(module => module.liveSurfaces ?? []).find(surface => surface.name === kind);
    if (kind !== "workspace" && !contributed) throw new Error("Unknown surface kind");
    const cacheKey = JSON.stringify([workspaceId, kind, key, params.agent ?? "", params.work ?? ""]);
    let surface = surfaces.get(cacheKey);
    if (!surface) {
      const resource = createLiveResource<SurfaceState>(async () => {
        const entry = requireWorkspace(workspaceId);
        if (contributed) return { kind: "regions", regions: await contributed.load({ workspaceId, key }) };
        if (entry.phase.kind === "runningPhase" && !entry.phase.deletion) {
          return { kind: "workspace", presentation: await prepareWorkspacePresentation(workspaceId, { agent: params.agent, workView: params.work }) };
        }
        return { kind: "regions", regions: [{ target: workspaceResidentId(workspaceId), html: entry.phase.deletion
          ? deletionPresentation(entry, entry.phase.deletion) : workspaceBootResidentHtml(entry) }] };
      }, state => state.kind === "workspace"
        ? workspaceRegions(state.presentation)
        : state.regions, reportPresentationError);
      surface = { workspaceId, kind, resource };
      surfaces.set(cacheKey, surface);
    }
    return surface.resource;
  }

  async function subscribeSurface(identifier: CableIdentifier, listener: (html: string) => void) {
    return surfaceFor(identifier).subscribe(listener);
  }

  deps.events?.on("agent_provider_default_changed", invalidatePresentation);
  deps.events?.on("workspace_agent_view_invalidated", invalidatePresentation);
  deps.events?.on("workspace_agent_conversation_title_changed", invalidatePresentation);

  const provisioningPrompts = new Map<string, string>();
  const provisioning = createWorkspaceProvisioning({ events: deps.events, onChange: (workspaceId) => {
    invalidatePresentation();
    const entry = registry.get(workspaceId);
    const snapshot = provisioning.snapshot(workspaceId);
    if (entry?.phase.kind === "provisioningPhase" && snapshot) {
      registry.setProvisioningState(workspaceId, snapshot.status === "waiting" ? "waiting" : snapshot.status === "failed" || snapshot.status === "cancelled" ? "failed" : "working", snapshot.error);
    }
  } });
  const workspaceCommandModalHostId = "workspace_command_modal_host";
  const launchComposerFrameId = "launch_composer";
  // The host prompt draft supplies a stable submission identity. Retried POSTs
  // therefore join the original launch instead of provisioning another Workspace.
  const launchComposerSubmissions = new Map<string, Promise<CreatedWorkspace>>();
  const launchComposerSettingsFrameId = "launch_composer_settings";
  const launchComposerFormId = "launch_composer_form";
  const projectRoutes = createProjectRoutes({
    referencingWorkspaces: (projectId) => registry.list()
      .filter((entry) => isGitProjectInit(entry.init) && entry.init.projectId === projectId)
      .map((entry) => ({ workspaceId: entry.id, title: workspaceTitle(entry) })),
    invalidatePresentation,
    renderLaunchComposer: renderProjectLaunchComposerFrame,
    createAgentWorkspace: async (project, request) => await createAgentWorkspaceFromForm(request, { project }),
    createOnboardingWorkspace,
    workspaceCommandModalHostId,
  });

  function workspaceResidentId(id: string): string {
    return domId("workspace_resident", id);
  }

  const globalRegions = new Map<string, readonly LiveRegion[]>();
  const globalSidebarContributionStore = new Map<string, string>();

  function renderGlobalSidebarContributions(): string {
    return Array.from(globalSidebarContributionStore.values()).filter(Boolean).join("");
  }

  const globalSidebarContributions: GlobalSidebarContributionRegistry = {
    set(contributionId, html, regions = []) {
      globalRegions.set(contributionId, regions);
      if (html) globalSidebarContributionStore.set(contributionId, html);
      else globalSidebarContributionStore.delete(contributionId);
      invalidatePresentation();
    },
  };

  function workspaceTitle(entry: WorkspaceEntry): string {
    return entry.title || (isGitProjectInit(entry.init) ? entry.init.name : undefined) || `Workspace ${entry.id}`;
  }

  const persistWorkspaceParked = deps.persistWorkspaceParked ?? setWorkspaceParked;
  let suppressParkedStateCallbacks = false;

  registry.setCallbacks({
    rowChanged(entry) {
      if (entry.phase.kind === "runningPhase") provisioningPrompts.delete(entry.id);
      invalidatePresentation();
    },
    listChanged() {
      if (suppressParkedStateCallbacks) return;
      invalidatePresentation();
    },
    parkedChanged(entry) {
      if (suppressParkedStateCallbacks) return;
      void persistWorkspaceParked(entry.id, entry.parked).catch((error) => logError(`could not persist parked state for workspace ${entry.id}: ${error instanceof Error ? error.message : String(error)}`));
    },
    removed(id) {
      workPresentationIntents.delete(id);
      provisioningPrompts.delete(id);
      provisioning.delete(id);
      for (const [key, surface] of surfaces) if (surface.workspaceId === id) { surface.resource.dispose(); surfaces.delete(key); }
      invalidatePresentation();
      for (const handler of deps.workspaceRemovedHandlers ?? []) void handler(id);
    },
  });

  // ---------------------------------------------------------------------------
  // Page shell
  // ---------------------------------------------------------------------------

  const layout = createPageLayout({ devReload: deps.devReload, workspaceModules });

  function launchComposerFooterContext(query = new URLSearchParams()) {
    return { frameId: launchComposerSettingsFrameId, formId: launchComposerFormId, url: "/launch-composer/settings", query };
  }

  async function renderLaunchComposerFrame(options: { titleCaption: string; action: string }): Promise<string> {
    const draftId = crypto.randomUUID();
    const providers = await orderedAgentProviders();
    const content = await launchComposerContent({ context: launchComposerFooterContext(), draftId, provider: providers[0]!, providers });
    return `<turbo-frame id="${launchComposerFrameId}">${dialogHtml({
      element: {
        attributesHtml: `data-controller="dialog launch-composer-dialog submit-shortcut" data-launch-composer-dialog-discard-url-value="${escapeHtml(content.discardUrl)}"`,
      },
      iconHtml: Icons.Workspace,
      titleCaption: options.titleCaption,
      closeLabel: "Close launch composer",
      bodyLayout: "full-bleed",
      bodyHtml: renderLaunchComposer({ action: options.action, formId: launchComposerFormId, content }),
    })}</turbo-frame>`;
  }

  async function renderProjectlessLaunchComposerFrame(): Promise<string> {
    return await renderLaunchComposerFrame({
      titleCaption: "Create empty workspace, and then…",
      action: "/agent-workspaces",
    });
  }

  async function renderProjectLaunchComposerFrame(project: ProjectSummary): Promise<string> {
    return await renderLaunchComposerFrame({
      titleCaption: `Create workspace from ${project.name}, and then…`,
      action: `/project-agent-workspaces/${encodeURIComponent(project.id)}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Workspace detail residency host
  // ---------------------------------------------------------------------------

  async function attachWorkspaceModules(workspaceId: string): Promise<WorkspaceAttachment[]> {
    const entry = requireWorkspace(workspaceId);
    const attachments = await Promise.all(workspaceModules
      .filter((module) => module.attachToWorkspace)
      .map((module) => module.attachToWorkspace!({ workspaceId, init: entry.init, events: deps.events })));
    const initialWorkViews = attachments.flatMap(attachment => attachment.workViews ?? [])
      .filter(view => view.initiallyOpen !== false).map(view => view.reference);
    await presentationStore.initialize(workspaceId, initialWorkViews);
    return attachments;
  }

  const workViewAdapterByType = new Map(workViewAdapters.map((adapter) => [adapter.type, adapter]));

  function workViewKey(reference: WorkspaceWorkViewReference): string {
    const adapter = workViewAdapterByType.get(reference.type);
    if (!adapter) throw new AtelierCoreError("work_view_reference_invalid", `unknown Work view type: ${reference.type}`);
    return `${reference.type}:${adapter.identity(reference)}`;
  }

  function workViewClose(workspaceId: string, reference: WorkspaceWorkViewReference, label: string) {
    const encoded = encodeURIComponent(JSON.stringify(reference));
    return { action: `/workspaces/${encodeURIComponent(workspaceId)}/work-views/${encoded}/close`, label: `${label} Work view` };
  }

  function agentClose(workspaceId: string, conversationId: string, title: string) {
    return { action: `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(conversationId)}/close`, label: `${title} Agent conversation` };
  }

  async function workspacePaneCollections(activeWorkspaceId: string): Promise<WorkspacePanePresentation> {
    const { projects: savedProjects, lastProjectlessWorkspaceCreatedAt } = await listProjects();
    const projectsById = new Map<string, WorkspacePaneProject>(savedProjects.map((project) => [project.id, {
      id: project.id, title: project.name, lastWorkspaceCreatedAt: project.lastWorkspaceCreatedAt,
    }]));
    const workspaces = registry.list().map((entry) => {
      let project: WorkspacePaneProject | undefined;
      if (isGitProjectInit(entry.init)) {
        project = projectsById.get(entry.init.projectId) ?? { id: entry.init.projectId, title: entry.init.name };
        projectsById.set(project.id, project);
      }
      return {
        id: entry.id,
        title: workspaceTitle(entry),
        active: entry.id === activeWorkspaceId,
        parked: entry.parked,
        project,
        busy: entry.phase.busy,
        requestingAttention: entry.requestingAttention,
        attentionAt: entry.attentionAt,
        lastActivityAt: entry.lastActivityAt,
        busyAgentKeys: registry.busyAgents(entry.id),
        outdated: entry.imageOutdated,
        issues: entry.issues,
      };
    });
    return { projects: [...projectsById.values()], lastProjectlessWorkspaceCreatedAt, workspaces };
  }

  function workViewPresentations(workspaceId: string, currentWorkViews: readonly WorkspaceWorkViewPresentation[], storedWorkViews: readonly WorkspaceWorkViewState[]): WorkPaneContribution[] {
    const currentByKey = new Map(currentWorkViews.map((view) => [workViewKey(view.reference), view]));
    return storedWorkViews.map((stored) => {
      const key = workViewKey(stored.reference);
      const contribution = currentByKey.get(key);
      const view: WorkPaneContribution = {
        key,
        iconHtml: contribution?.iconHtml,
        label: contribution?.label ?? `${stored.reference.type} unavailable`,
        kind: contribution?.kind ?? "resource",
        availability: contribution?.availability ?? { phase: "unavailable", detail: "The referenced resource is not currently available." },
        close: workViewClose(workspaceId, stored.reference, contribution?.label ?? stored.reference.type),
      };
      if (contribution?.sourceKey !== undefined) view.sourceKey = contribution.sourceKey;
      if (contribution?.actionsHtml !== undefined) view.actionsHtml = contribution.actionsHtml;
      Object.assign(view, registry.surfaceState(workspaceId, key));
      return view;
    });
  }

  interface WorkspaceWarningState {
    warnings: WorkspaceWarning[];
    dismissedWarnings: Record<string, string>;
  }

  async function workspaceWarningState(entry: WorkspaceEntry, project?: ProjectConfiguration): Promise<WorkspaceWarningState> {
    const [configuration, dismissedWarnings] = await Promise.all([
      project ?? (isGitProjectInit(entry.init) ? getProjectConfiguration(entry.init.projectId) : undefined),
      presentationStore.dismissedWarnings(entry.id),
    ]);
    return { warnings: workspaceWarnings(entry, configuration), dismissedWarnings };
  }

  async function agentPaneContributions(workspaceId: string) {
    return (await agentTabs.list({ workspaceId })).map((conversation) => ({
      ...conversation,
      ...registry.agentState(workspaceId, `agent:${conversation.id}`),
      close: agentClose(workspaceId, conversation.id, conversation.title),
    }));
  }

  async function workspacePresentationBundle(workspaceId: string): Promise<{
    presentation: FixedWorkspacePresentation;
    commandContributions: WorkspaceCommandContribution[];
    storedWorkViews: WorkspaceWorkViewState[];
    warningState: WorkspaceWarningState;
  }> {
    const entry = requireWorkspace(workspaceId);
    const attachments = await attachWorkspaceModules(workspaceId);
    const agentConversations = await agentPaneContributions(workspaceId);
    const currentWorkViews = attachments.flatMap((attachment) => attachment.workViews ?? []);
    const storedWorkViews = await presentationStore.listWorkViews(workspaceId);
    const commandContributions: WorkspaceCommandContribution[] = [...attachments.flatMap((attachment) => attachment.commands ?? []),
      { id: "agent.create", label: "New Agent", scope: "workspace" },
      ...agentProviders.map((provider) => ({ id: `agent.create.${provider.id}`, label: `New ${provider.label} agent`, scope: "workspace" as const })),
    ];
    const commands = commandContributions.map((command) => ({
      id: command.id, label: command.surfaces?.ui?.label ?? command.label, description: command.description, scope: command.scope, placement: command.surfaces?.ui?.placement, iconHtml: command.surfaces?.ui?.iconHtml, binding: command.surfaces?.shortcut?.defaultBinding,
    }));
    const warningState = await workspaceWarningState(entry);
    const intent = workPresentationIntents.get(workspaceId);
    const workPresentationIntent = intent && registry.surfaceState(workspaceId, intent.key).requestingAttention ? intent : undefined;
    const presentation: FixedWorkspacePresentation = {
      workspace: { id: entry.id, title: workspaceTitle(entry) },
      agentProviders: await orderedAgentProviders(),
      agentConversations,
      workViews: workViewPresentations(workspaceId, currentWorkViews, storedWorkViews),
      commands,
      workPresentationIntent,
      warningsHtml: workspaceWarningsHtml(entry.id, warningState),
      overlayHtml: attachments.flatMap((attachment) => attachment.overlayHtml ?? []),
    };
    return { presentation, commandContributions, storedWorkViews, warningState };
  }

  function workspaceWarningsHtml(workspaceId: string, { warnings, dismissedWarnings }: WorkspaceWarningState): string {
    return warnings.filter((warning) => dismissedWarnings[warning.kind] !== warning.state).map((warning) => warningBannerHtml({
      title: warning.title,
      message: warning.message,
      actionsHtml: warning.action ? actionLinkHtml({ href: warning.action.href, variant: "secondary", content: { kind: "caption", caption: warning.action.caption }, attributesHtml: 'data-turbo-stream="true"' }) : undefined,
      dismiss: { action: `/workspaces/${encodeURIComponent(workspaceId)}/warnings/${encodeURIComponent(warning.kind)}/dismiss`, state: warning.state },
    })).join("");
  }

  async function dismissWorkspaceWarning(id: string, kind: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    const state = requestAcceptsJson(request) ? (await readJsonObject(request)).state : (await request.formData()).get("state");
    const warningState = await workspaceWarningState(entry);
    const warning = warningState.warnings.find((candidate) => candidate.kind === kind && candidate.state === state);
    if (!warning) throw invalidArguments("warning is no longer current");
    await presentationStore.dismissWarning(id, kind, warning.state);
    invalidatePresentation();
    return requestAcceptsJson(request) ? jsonResponse({ dismissed: true }) : turboStreamResponse("");
  }

  function workspaceRegions(presentation: FixedWorkspacePresentation): readonly LiveRegion[] {
    const workspaceId = presentation.workspace.id;
    return [{
      target: workspaceResidentId(workspaceId),
      html: renderWorkspacePresentation({ ...presentation,
        agentConversations: presentation.agentConversations.map(agent => ({ ...agent, bodyHtml: undefined })),
        workViews: presentation.workViews.map(view => ({ ...view, bodyHtml: undefined })),
      }),
      children: [
        ...presentation.agentConversations.flatMap(agent => agent.bodyHtml === undefined ? [] : [{ target: agentContentId(workspaceId, agent.id), html: agent.bodyHtml }]),
        ...presentation.workViews.flatMap(view => view.bodyHtml === undefined ? [] : [{ target: workContentId(workspaceId, view.key), html: view.bodyHtml }]),
      ],
    }];
  }

  async function prepareWorkspacePresentation(id: string, selection: NonNullable<FixedWorkspacePresentation["initialSelection"]>): Promise<FixedWorkspacePresentation> {
    const { presentation, storedWorkViews } = await workspacePresentationBundle(id);
    presentation.initialSelection = {
      agent: presentation.agentConversations.find(agent => agent.id === selection.agent)?.id ?? presentation.agentConversations[0]?.id,
      workView: presentation.workViews.find(view => view.key === selection.workView)?.key,
    };
    await Promise.all([
      ...presentation.agentConversations.filter(agent => agent.id === presentation.initialSelection!.agent).map(async agent => { agent.bodyHtml = await agentTabs.render({ workspaceId: id, conversationId: agent.id }); }),
      ...presentation.workViews.filter(view => view.key === presentation.initialSelection!.workView).map(async view => {
        if (view.availability.phase === "unavailable") return;
        const reference = storedWorkViews.find(stored => workViewKey(stored.reference) === view.key)!.reference;
        view.bodyHtml = await workViewAdapterByType.get(reference.type)!.render({ workspaceId: id, reference });
      }),
    ]);
    return presentation;
  }

  function workspaceBootResidentHtml(entry: WorkspaceEntry): string {
    const projectId = isGitProjectInit(entry.init) ? entry.init.projectId : undefined;
    const deleteButton = buttonHtml({ type: "submit", variant: "danger", content: { kind: "caption", caption: "Delete workspace" } });
    const deleteAction = `<form class="workspace-boot-actions" method="post" action="/workspaces/${encodeURIComponent(entry.id)}/delete">${deleteButton}</form>`;
    const snapshot = provisioning.snapshot(entry.id);
    const failed = entry.phase.kind === "provisioningPhase" && entry.phase.status === "failed";
    const sourceFailure = snapshot?.steps.find((step) => step.id === "workspace.source" && step.status === "failed");
    const needsSshKey = !!sourceFailure?.error && isSshAuthenticationFailure(sourceFailure.error);
    const recoveryActions = (failed || sourceFailure) && projectId
      ? actionLinkHtml({ href: `/projects/${encodeURIComponent(projectId)}/settings?section=${needsSshKey ? "ssh-keys" : "repository"}`, variant: "primary", content: { kind: "caption", caption: needsSshKey ? "Add project SSH key" : "Open Project settings" }, attributesHtml: 'data-turbo-stream="true"' })
      : "";
    const recovery = sourceFailure ? {
      stepId: sourceFailure.id,
      description: needsSshKey ? "SSH authentication failed. An SSH key with access to this repository may resolve this. Add it to this project, then retry." : undefined,
      actionsHtml: recoveryActions,
    } : undefined;
    const inner = `${renderWorkspaceProvisioning(entry.id, snapshot, { failed, error: entry.phase.error, recovery })}${sourceFailure ? "" : recoveryActions}${deleteAction}`;
    return `<div class="workspace-boot"><div class="main"><div class="body"><div class="workspace-boot-progress"><div class="workspace-boot-content">${inner}</div></div>${renderWorkspaceLaunchPrompt(provisioningPrompts.get(entry.id))}</div></div>${renderMobileWorkspaceBar()}</div>`;
  }

  const emptyWorkspaceOnboardingId = "workspace_empty_onboarding";

  function emptyWorkspaceOnboardingHtml(pane: WorkspacePanePresentation): string {
    const state = workspacePaneOnboardingState(pane);
    const copy = state === "first-project"
      ? '<h1>Welcome to your Atelier!</h1><p>Create your <strong data-empty-workspace-onboarding-target="origin">first project</strong> to get started!</p>'
      : state === "first-workspace"
        ? '<h1>Welcome to your Atelier!</h1><p>Create your <strong data-empty-workspace-onboarding-target="origin">first workspace</strong> to get started!</p>'
        : '<h1>Welcome to your Atelier</h1><p><strong data-empty-workspace-onboarding-target="origin">Select a workspace</strong> to get started.</p>';
    const welcome = `<section class="workspace-empty-welcome" data-empty-workspace-state="${state}">${copy}</section>`;
    if (state === "workspaces") return `<div id="${emptyWorkspaceOnboardingId}">${welcome}</div>`;
    return `<div id="${emptyWorkspaceOnboardingId}" data-controller="empty-workspace-onboarding" data-empty-workspace-onboarding-destination-value="${state}">
      ${welcome}
      <svg class="workspace-empty-onboarding-arrow" aria-hidden="true" data-empty-workspace-onboarding-target="svg">
        <defs><marker id="workspace-empty-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 10 5 0 10z"></path></marker></defs>
        <path data-empty-workspace-onboarding-target="path" marker-end="url(#workspace-empty-arrowhead)"></path>
      </svg>
    </div>`;
  }

  function workspaceMounts(selectedId?: string, selectedHtml = "", selection?: FixedWorkspacePresentation["initialSelection"]): string {
    // Residents are invisible siblings, not the sorted workspace list. Keep their DOM order stable
    // when attention clears and the list reorders; moving a permanent mount disconnects it.
    return registry.list().filter(entry => !entry.parked).sort((a, b) => a.id.localeCompare(b.id)).map(entry => `<div id="${workspaceResidentId(entry.id)}" class="workspace-detail-resident${entry.id === selectedId ? " visible" : ""}" data-turbo-permanent data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(entry.id)}" data-controller="live-surface" data-live-surface-workspace-value="${escapeHtml(entry.id)}" data-live-surface-kind-value="workspace" data-live-surface-eager-value="${entry.id === selectedId}" data-live-surface-agent-value="${entry.id === selectedId ? escapeHtml(selection?.agent ?? "") : ""}" data-live-surface-work-value="${entry.id === selectedId ? escapeHtml(selection?.workView ?? "") : ""}">${entry.id === selectedId ? selectedHtml : ""}</div>`).join("");
  }

  async function workspaceDetailHostHtml(pane: WorkspacePanePresentation, selectedId?: string, initialSelection?: FixedWorkspacePresentation["initialSelection"]): Promise<string> {
    const entry = selectedId ? requireWorkspace(selectedId) : undefined;
    const state = entry ? await surfaceFor({ channel: "module", name: "surface", workspaceId: entry.id, params: { kind: "workspace", agent: initialSelection?.agent ?? "", work: initialSelection?.workView ?? "" } }).read() : undefined;
    const selectedHtml = !state ? "" : state.kind === "workspace"
      ? renderWorkspacePresentation(state.presentation)
      : state.regions.map(region => region.html).join("");
    return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-residency" data-workspace-residency-max-resident-value="5">
      <div class="workspace-detail-empty" data-workspace-residency-target="empty"${selectedId ? " hidden" : ""}>${emptyWorkspaceOnboardingHtml(pane)}</div>
      <div class="workspace-detail-loading" data-workspace-residency-target="loading" hidden><div class="workspace-detail-loading-status" role="status"><span class="status-spinner" aria-hidden="true"></span> Loading workspace…</div></div>
      <div id="workspace_residents" style="display:contents">${workspaceMounts(selectedId, selectedHtml, state?.kind === "workspace" ? state.presentation.initialSelection : initialSelection)}</div>
    </div>`;
  }

  type ShellSurface =
    | { kind: "module-modal"; dialogHtml: string }
    | { kind: "project-editor"; dialogHtml: string }
    | { kind: "new-workspace"; project?: ProjectSummary }
    | { kind: "settings"; section: string | undefined; development?: true };

  async function renderWorkspaceShell(selectedId?: string, surface?: ShellSurface, initialSelection?: FixedWorkspacePresentation["initialSelection"]): Promise<string> {
    const pane = await workspacePaneCollections(selectedId ?? "");
    const projectEditor = surface?.kind === "project-editor" ? surface.dialogHtml : '<div id="project-editor-modal"></div>';
    const settings = surface?.kind === "settings"
      ? surface.development ? await renderDevelopmentSettingsDialog() : await renderSettingsDialog(surface.section)
      : "";
    const launchComposer = surface?.kind === "new-workspace"
      ? surface.project ? await renderProjectLaunchComposerFrame(surface.project) : await renderProjectlessLaunchComposerFrame()
      : `<turbo-frame id="${launchComposerFrameId}"></turbo-frame>`;
    return `<div class="app fixed-shell-app" data-controller="atelier-shortcuts workspace-navigation">
    ${renderWorkspacePane(pane, renderGlobalSidebarContributions(), workspaceModules.map((module) => module.renderWorkspacePaneActions?.() ?? "").join(""))}
    <main class="fixed-shell-app-main">${await workspaceDetailHostHtml(pane, selectedId, initialSelection)}</main>
    ${renderAtelierBar()}
  </div>
  ${projectEditor}
  <div id="update_modal_host"></div>
  <div id="settings_modal_host">${settings}</div>
  <turbo-frame id="${workspaceModuleModalFrameId}">${surface?.kind === "module-modal" ? surface.dialogHtml : ""}</turbo-frame>
  <div id="onboarding_modal_host">${await renderOnboardingDialog()}</div>
  <div id="${workspaceCommandModalHostId}"></div>
  ${launchComposer}`;
  }

  async function homePage(): Promise<Response> {
    const selected = registry.list().find((entry) => !entry.parked);
    return response(layout(await renderWorkspaceShell(selected?.id)));
  }

  async function projectEditorResponse(request: Request, options: ProjectEditorModalOptions): Promise<Response> {
    const dialogHtml = await projectRoutes.editorModal(options, request);
    return wantsTurboStream(request)
      ? turboStreamResponse(turboReplaceStream("project-editor-modal", dialogHtml))
      : surfacePage({ kind: "project-editor", dialogHtml });
  }

  async function surfacePage(surface: ShellSurface): Promise<Response> {
    const selected = registry.list().find((entry) => !entry.parked);
    return response(layout(await renderWorkspaceShell(selected?.id, surface)));
  }

  function requireWorkspace(id: string): WorkspaceEntry {
    const entry = registry.get(id);
    if (!entry) throw new AtelierCoreError("workspace_not_found", `workspace not found: ${id}`);
    return entry;
  }

  function workViewSummaries(id: string, views: WorkspaceWorkViewState[]) {
    return views.map((view) => ({ key: workViewKey(view.reference), ...view, ...registry.surfaceState(id, workViewKey(view.reference)) }));
  }

  async function workspaceJson(id: string): Promise<Response> {
    const entry = requireWorkspace(id);
    const workspace: Pick<WorkspaceEntry, "id" | "phase" | "parked" | "requestingAttention" | "issues"> & { title: string; url: string } = {
      id: entry.id,
      title: workspaceTitle(entry),
      phase: entry.phase,
      parked: entry.parked,
      requestingAttention: entry.requestingAttention,
      url: `/workspaces/${encodeURIComponent(entry.id)}`,
    };
    if (entry.issues?.length) workspace.issues = entry.issues;
    if (entry.parked || entry.phase.kind !== "runningPhase") return jsonResponse({ workspace });

    const { presentation, commandContributions, storedWorkViews, warningState } = await workspacePresentationBundle(id);
    const handlers = new Map(workspaceModuleCommands().map((handler) => [handler.id, handler]));
    return jsonResponse({ workspace: {
      ...workspace,
      ...warningState,
      agentConversations: presentation.agentConversations.map(({ id, title, providerId, busy, requestingAttention }) => ({ id, title, providerId, busy, requestingAttention })),
      workViews: workViewSummaries(id, storedWorkViews),
      commands: commandContributions.filter((command) => handlers.has(command.id)).map((command) => ({
        id: command.id,
        label: command.label,
        description: command.description,
        scope: command.scope,
        inputSchema: handlers.get(command.id)?.inputSchema ?? command.inputSchema ?? emptyWorkspaceCommandInputSchema,
      })),
    } });
  }

  function workspaceListEndpoint(request: Request, url: URL): Response {
    if (!requestAcceptsJson(request)) return Response.redirect(new URL("/", url).toString(), 302);
    return jsonResponse({ workspaces: registry.list().map((entry) => {
      const workspace: Pick<WorkspaceEntry, "id" | "phase" | "parked" | "requestingAttention" | "issues"> & { title: string; projectId?: string } = {
        id: entry.id,
        title: workspaceTitle(entry),
        phase: entry.phase,
        parked: entry.parked,
      requestingAttention: entry.requestingAttention,
      };
      if (entry.issues?.length) workspace.issues = entry.issues;
      if (isGitProjectInit(entry.init)) workspace.projectId = entry.init.projectId;
      return workspace;
    }) });
  }

  async function workspacePage(id: string, request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) return await workspaceJson(id);
    const entry = requireWorkspace(id);
    if (entry.parked) return Response.redirect(new URL("/", request.url).toString(), 302);
    const params = new URL(request.url).searchParams;
    return response(layout(await renderWorkspaceShell(id, undefined, { agent: params.get("agent") ?? undefined, workView: params.get("workView") ?? undefined })));
  }

  // ---------------------------------------------------------------------------
  // Create / delete
  // ---------------------------------------------------------------------------

  function startWorkspaceProvisioning(id: string, options: { init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; title?: string } = {}): void {
    void (async () => {
      try {
        await provisioning.run(id, (run) => deps.provisionWorkspace(id, { init: options.init, context: options.context, run }));
        const entry = registry.get(id);
        if (!entry || entry.phase.deletion) return;
        const warnings = provisioning.snapshot(id)!.steps.filter((step) => step.status === "warning");
        if (warnings.length) registry.setIssue(id, "readiness", warnings.map((step) => `${step.label}: ${step.error} Continued despite this failure.`).join("\n"));
        if (options.title) await setWorkspaceTitle(id, options.title);
        registry.startRunning(id);
        const launchPrompt = options.context?.agent?.initialPrompt?.trim();
        if (!options.title && launchPrompt && !options.context?.agent?.initialPromptMode) {
          maybeNameWorkspaceFromPrompt(id, launchPrompt, { events: deps.events, agentModel: options.context?.agent?.model ? parseModelRef(options.context.agent.model) : undefined });
        }
        if (options.context?.agent?.initialPrompt !== undefined && !options.context.agent.initialPrompt.trim()) registry.requestAttention(id);
      } catch (error) {
        const entry = registry.get(id);
        if (!entry || entry.phase.deletion) return;
        const message = error instanceof Error ? error.message : String(error);
        logError(`could not provision workspace ${id}: ${message}`);
        registry.setProvisioningState(id, "failed", message);
      }
    })();
  }

  interface CreatedWorkspace {
    id: string;
    isFirstWorkspace: boolean;
  }

  async function createWorkspaceFromCommand(command: { init?: WorkspaceInitInstruction; agent?: JsonObject; context?: WorkspaceCreationContext; title?: string; projectOnboarding?: true }): Promise<CreatedWorkspace> {
    const isFirstWorkspace = registry.list().length === 0;
    const id = generateWorkspaceId();
    const init = command.init;
    const title = command.title?.trim() ?? "";
    let context = command.context;
    if (!context) {
      const providerId = stringField(command.agent?.provider, "agent.provider");
      const provider = providerId ? agentProvider(providerId) : await defaultAgentProvider();
      const initialPrompt = stringField(command.agent?.initialPrompt, "agent.initialPrompt");
      const attachmentDraft = stringField(command.agent?.attachmentDraft, "agent.attachmentDraft");
      if (attachmentDraft && !validDraftId(attachmentDraft)) throw invalidArguments("Invalid attachment draft");
      const prepared = await provider.launch.prepare(command.agent);
      context = { ...prepared, agent: { ...prepared?.agent, initialPrompt, attachmentDraft, provider: provider.id } };
    }
    if (command.projectOnboarding) context = { ...context, projectOnboarding: true };
    if (context?.agent?.initialPrompt) provisioningPrompts.set(id, context.agent.initialPrompt);
    registry.add(id, title || null, init);
    const options: Parameters<typeof startWorkspaceProvisioning>[1] = {};
    if (init !== undefined) options.init = init;
    if (context) options.context = context;
    if (title) options.title = title;
    startWorkspaceProvisioning(id, options);
    return { id, isFirstWorkspace };
  }

  function workspaceCreatedJsonResponse(id: string): Response {
    const location = `/workspaces/${encodeURIComponent(id)}`;
    return jsonResponse({ workspace: { id, phase: requireWorkspace(id).phase, requestingAttention: requireWorkspace(id).requestingAttention, url: location } }, { status: 202, headers: { location } });
  }

  async function createOnboardingWorkspace(project: ProjectSummary, request: Request): Promise<Response> {
    const { settingsRevision } = await readProjectWorkspaceSettings(project.id);
    const init = await projectWorkspaceInitWithSettings(project.id, settingsRevision, { dockerfile: "FROM atelier-workspace", preloadImages: [], environment: [] });
    const { id } = await createWorkspaceFromCommand({
      init,
      projectOnboarding: true,
      title: `Set up ${project.name}`,
      agent: { initialPrompt: projectOnboardingInitialPrompt(project.name) },
    });
    const location = `/workspaces/${encodeURIComponent(id)}`;
    if (requestAcceptsJson(request)) return workspaceCreatedJsonResponse(id);
    if (wantsTurboStream(request)) return turboStreamResponse(`${turboReplaceStream("project-editor-modal", '<div id="project-editor-modal"></div>')}${selectWorkspaceTurboStream(id)}`);
    return new Response(null, { status: 303, headers: { location } });
  }

  async function createWorkspaceEndpoint(request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) {
      const body = await readWorkspaceCreateJson(request);
      const sourceType = stringField(body.source?.type, "source.type") ?? "empty";
      if (sourceType !== "empty" && sourceType !== "project") throw invalidArguments("source.type must be empty or project");
      const projectReference = stringField(body.source?.project, "source.project");
      let init: WorkspaceInitInstruction | undefined;
      if (sourceType === "project") {
        if (!projectReference) throw invalidArguments("source.project is required for project workspaces");
        init = projectWorkspaceInit(await projectRoutes.byReference(projectReference));
      }
      const { id } = await createWorkspaceFromCommand({ init, title: stringField(body.title, "title"), agent: body.agent });
      return workspaceCreatedJsonResponse(id);
    }

    const { id } = await createWorkspaceFromCommand({});
    const location = `/workspaces/${encodeURIComponent(id)}`;
    if (wantsTurboStream(request)) return turboStreamResponse("", { headers: { location } });
    return new Response(null, { status: 303, headers: { location } });
  }

  async function createAgentWorkspaceFromForm(request: Request, options: { project?: ProjectSummary } = {}): Promise<Response> {
    const form = await request.formData();
    const submissionId = String(form.get("attachmentDraft") ?? "");
    if (!validDraftId(submissionId)) throw invalidArguments("Invalid attachment draft");
    const provider = agentProvider(String(form.get("provider") ?? "builtin"));
    const submission = await provider.launch.submit(form);
    if ("response" in submission) return submission.response;
    let launch = launchComposerSubmissions.get(submissionId);
    if (!launch) {
      launch = (async () => {
        const prepared = await submission.prepare();
        return createWorkspaceFromCommand({
          init: options.project ? projectWorkspaceInit(options.project) : undefined,
          context: { ...prepared, agent: { ...prepared.agent, provider: provider.id, initialPrompt: String(form.get("text") ?? ""), attachmentDraft: submissionId } },
        });
      })();
      launchComposerSubmissions.set(submissionId, launch);
    }
    const { id, isFirstWorkspace } = await launch;
    return turboStreamResponse(`${turboUpdateStream(launchComposerFrameId, "")}${isFirstWorkspace ? selectWorkspaceTurboStream(id) : ""}`);
  }

  async function createEmptyAgentWorkspaceEndpoint(request: Request): Promise<Response> {
    return await createAgentWorkspaceFromForm(request);
  }

  type WorkspaceCreateJsonBody = {
    source?: JsonObject;
    title?: JsonValue;
    agent?: JsonObject;
  };

  async function readWorkspaceCreateJson(request: Request): Promise<WorkspaceCreateJsonBody> {
    const record = await readJsonObject(request);
    const { source, title, agent } = record;
    if (source !== undefined && !isJsonObject(source)) throw invalidArguments("source must be an object");
    if (agent !== undefined && !isJsonObject(agent)) throw invalidArguments("agent must be an object");
    return { source, title, agent };
  }

  function stringField(value: JsonValue | undefined, name: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Value.Check(jsonStringSchema, value)) throw invalidArguments(`${name} must be a string`);
    return value.trim();
  }

  function deletionPresentation(entry: WorkspaceEntry, state: WorkspaceDeletionState): string {
    const details = state.status === "blocked" ? deletion.evidence(entry.id) : undefined;
    const evidence = details === undefined ? undefined : deletionReview.renderEvidence(entry.id, details);
    return renderWorkspaceDeletionPresentation(entry.id, state, evidence);
  }

  async function forceDeleteAllWorkspacesFromSettings(): Promise<{ deleted: number; errors: string[] }> {
    const { workspaces } = await listWorkspaces();
    return deletion.destroyAll(workspaces.map((workspace) => workspace.id));
  }

  function deleteCurrentWorkspaceFromAgent(id: string, force: boolean): Promise<DeleteCurrentWorkspaceResult> {
    return deletion.request(id, { force });
  }

  function continueWorkspaceProvisioningEndpoint(id: string, request: Request): Response {
    const entry = requireWorkspace(id);
    if (entry.phase.kind !== "provisioningPhase") throw new AtelierCoreError("workspace_not_ready", `workspace ${id} is not waiting for provisioning confirmation`);
    const action = new URL(request.url).searchParams.get("action");
    if (action !== null && action !== "retry") throw invalidArguments("Unknown provisioning action");
    const stepId = provisioning.resume(id, action === "retry" ? "retry" : "continue");
    if (requestAcceptsJson(request)) return jsonResponse({ continued: true, stepId });
    return turboStreamResponse("");
  }

  async function deleteWorkspaceEndpoint(id: string, request: Request): Promise<Response> {
    if (!deletion.canRequest(id)) {
      if (requestAcceptsJson(request)) return jsonResponse({ error: { code: "workspace_not_ready", message: `workspace ${id} is not ready for deletion` } }, { status: 409 });
      return turboStreamResponse("", { status: 409 });
    }
    const force = requestAcceptsJson(request)
      ? (await readJsonObject(request)).force === true
      : new URL(request.url).searchParams.get("force") === "1";
    const result = await deletion.request(id, { force });
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse("");
  }

  function cancelWorkspaceDeletionEndpoint(id: string, request: Request): Response {
    if (!deletion.cancel(id)) return turboStreamResponse("", { status: 409 });
    // The registry phase change restores the resident through the same path as startup.
    return requestAcceptsJson(request) ? jsonResponse({ cancelled: true }) : turboStreamResponse("");
  }

  async function confirmWorkspaceDeletionEndpoint(id: string, request: Request): Promise<Response> {
    const fingerprint = String((await request.formData()).get("fingerprint") ?? "");
    const result = await deletion.request(id, { fingerprint });
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse("");
  }

  async function retryWorkspaceDeletionEndpoint(id: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.phase.deletion?.status !== "failed") return turboStreamResponse("", { status: 409 });
    const result = await deletion.request(id);
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse("");
  }

  async function requestWorkspaceParkedState(id: string, parked: boolean, force = false): Promise<
    { kind: "confirmation"; workViews: WorkspaceWorkViewState[] } | { kind: "updated"; stream: string }
  > {
    return await serializePresentationMutation(id, async () => {
      const entry = requireWorkspace(id);
      if (entry.phase.kind !== "runningPhase") throw new AtelierCoreError("workspace_not_ready", `workspace ${id} is not ready`);
      const affected = parked ? (await workspacePresentationBundle(id)).storedWorkViews.filter(({ reference }) => reference.type === "terminal" || reference.type === "vscode") : [];
      if (affected.length && !force) return { kind: "confirmation", workViews: affected };
      for (const { reference } of affected) await closeWorkView(id, reference);
      if (entry.parked !== parked) {
        await persistWorkspaceParked(id, parked);
        suppressParkedStateCallbacks = true;
        registry.setParked(id, parked);
        suppressParkedStateCallbacks = false;
      }
      const parkedResident = parked ? dismissWorkspaceParkConfirmationTurboStream(id) : "";
      const stream = `${parkedResident}`;
      invalidatePresentation();
      return { kind: "updated", stream };
    });
  }

  async function parkWorkspaceEndpoint(id: string, parked: boolean, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.phase.kind !== "runningPhase") return requestAcceptsJson(request)
      ? jsonResponse({ error: { code: "workspace_not_ready", message: `workspace ${id} is not ready` } }, { status: 409 })
      : wantsTurboStream(request) ? turboStreamResponse("", { status: 409 }) : response("Workspace is not ready", { status: 409 });
    const force = new URL(request.url).searchParams.get("force") === "1";
    const result = await requestWorkspaceParkedState(id, parked, force);
    if (result.kind === "confirmation") {
      if (requestAcceptsJson(request)) return jsonResponse({ error: { code: "workspace_park_confirmation_required", message: "Terminal and VS Code sessions cannot recover after parking." }, workViews: result.workViews }, { status: 409 });
      const confirmation = renderWorkspaceParkConfirmation(id, workspaceTitle(entry));
      return wantsTurboStream(request)
        ? turboStreamResponse(turboUpdateStream(workspaceModuleModalFrameId, confirmation))
        : await surfacePage({ kind: "module-modal", dialogHtml: confirmation });
    }
    if (requestAcceptsJson(request)) return jsonResponse({ workspace: { id, parked } });
    if (wantsTurboStream(request)) return turboStreamResponse(result.stream);
    return Response.redirect(request.headers.get("referer") ?? "/", 303);
  }

  // ---------------------------------------------------------------------------
  // Titles
  // ---------------------------------------------------------------------------

  async function updateWorkspaceSidebarTitle(id: string, request: Request): Promise<Response> {
    requireWorkspace(id);
    const title = requestAcceptsJson(request)
      ? stringField((await readJsonObject(request)).title, "title") ?? ""
      : String((await request.formData()).get("title") ?? "").trim();
    await setWorkspaceTitle(id, title);
    registry.setTitle(id, title || null);
    return requestAcceptsJson(request) ? await workspaceJson(id) : turboStreamResponse("");
  }

  function workspaceModuleCommands(): WorkspaceModuleCommandHandler[] {
    const create = async (workspaceId: string, providerId?: string) => {
      const provider = providerId ? agentProvider(providerId) : await defaultAgentProvider();
      const createdAgentConversationId = await provider.create({ workspaceId, events: deps.events });
      await rememberAgentProvider(provider.id, deps.events);
      return { createdAgentConversationId };
    };
    return [
      ...workspaceModules.flatMap((module) => module.commands ?? []),
      { id: "agent.create", execute: ({ workspaceId }) => create(workspaceId) },
      ...agentProviders.map((provider): WorkspaceModuleCommandHandler => ({ id: `agent.create.${provider.id}`, execute: ({ workspaceId }) => create(workspaceId, provider.id) })),
    ];
  }

  function workspaceModuleRoutes(): WorkspaceModuleRouteHandler[] {
    return workspaceModules.flatMap((module) => module.routes ?? []);
  }

  async function commandInput<Input>(request: Request, command: WorkspaceModuleCommandHandler<Input>): Promise<Input> {
    let input = {};
    if (requestAcceptsJson(request)) {
      const text = await request.text();
      if (text.trim()) {
        try { input = JSON.parse(text); } catch { throw invalidArguments("valid JSON command input is required"); }
      }
    }
    if (!isJsonObject(input)) throw invalidArguments("JSON command input must be an object");
    const schema = command.inputSchema ?? emptyWorkspaceCommandInputSchema;
    // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
    if (!Value.Check(schema as never, input)) {
      // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
      const issue = [...Value.Errors(schema as never, input)][0];
      throw invalidArguments(`invalid ${command.id} input: ${issue?.message ?? "schema check failed"}`);
    }
    // SAFETY: the command-owned schema validated input against the handler's Input contract.
    return input as Input;
  }

  async function executeWorkspaceCommand(workspaceId: string, commandId: string, request: Request): Promise<WorkspaceModuleCommandResult> {
    const commands = workspaceModuleCommands();
    const command = commands.find((candidate) => candidate.id === commandId);
    if (!command) throw new AtelierCoreError("command_not_found", `workspace command not found: ${commandId}`, { availableCommands: commands.map((candidate) => candidate.id) });
    return await command.execute({ workspaceId, events: deps.events, input: await commandInput(request, command) });
  }

  async function openAvailableWorkView(workspaceId: string, reference: WorkspaceWorkViewReference) {
    const key = workViewKey(reference);
    const attachments = await attachWorkspaceModules(workspaceId);
    const contribution = attachments.flatMap((attachment) => attachment.workViews ?? []).find((view) => workViewKey(view.reference) === key);
    if (!contribution) throw new AtelierCoreError("work_view_not_found", `Work view is not available: ${key}`);
    await presentationStore.openWorkView(workspaceId, contribution.reference);
    return { reference: contribution.reference, key };
  }

  async function openWorkspaceModuleWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, request: Request, options: { select?: boolean } = {}): Promise<Response> {
    return await serializePresentationMutation(workspaceId, async () => {
      const { key } = await openAvailableWorkView(workspaceId, reference);
      // Navigation GETs can open a view too; they do not pass through the POST invalidation path.
      invalidateWorkspace(workspaceId);
      return turboStreamResponse(options.select === false || (requestAcceptsJson(request) && !wantsTurboStream(request)) ? "" : presentWorkViewTurboStream(workspaceId, key));
    });
  }

  async function workspaceCommandEndpoint(workspaceId: string, commandId: string, request: Request): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId, request);
    let createdWorkView: WorkspaceWorkViewReference | undefined;
    if (result.createdWorkView) {
      ({ reference: createdWorkView } = await openAvailableWorkView(workspaceId, result.createdWorkView));
    }
    const origin = `${result.createdAgentConversationId ? selectAgentTurboStream(workspaceId, result.createdAgentConversationId) : ""}${createdWorkView ? presentWorkViewTurboStream(workspaceId, workViewKey(createdWorkView)) : ""}${result.streamHtml ?? ""}`;
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) {
      const command: WorkspaceCommandResponse = { id: commandId };
      if (createdWorkView) command.workView = createdWorkView;
      if (result.createdAgentConversationId) command.agentConversationId = result.createdAgentConversationId;
      return jsonResponse({ command, workViews: workViewSummaries(workspaceId, await presentationStore.listWorkViews(workspaceId)) });
    }
    return turboStreamResponse(origin);
  }

  async function closeWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    await workViewAdapterByType.get(reference.type)!.close?.({ workspaceId, reference });
    await presentationStore.closeWorkView(workspaceId, reference);
    if (workPresentationIntents.get(workspaceId)?.key === workViewKey(reference)) workPresentationIntents.delete(workspaceId);
    registry.clearSurfaceAttention(workspaceId, workViewKey(reference));
  }

  async function closeWorkViewEndpoint(workspaceId: string, encodedReference: string, request: Request): Promise<Response> {
    // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
    const reference = JSON.parse(encodedReference) as WorkspaceWorkViewReference;
    const adapter = workViewAdapterByType.get(reference.type);
    if (!adapter) throw new AtelierCoreError("work_view_reference_invalid", `unknown Work view type: ${reference.type}`);
    const parsed = adapter.parseReference(reference);
    const before = await presentationStore.listWorkViews(workspaceId);
    if (!before.some(view => workViewKey(view.reference) === workViewKey(parsed))) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${workViewKey(parsed)}`);
    await closeWorkView(workspaceId, parsed);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) return jsonResponse({ closed: parsed, workViews: workViewSummaries(workspaceId, await presentationStore.listWorkViews(workspaceId)) });
    return turboStreamResponse("");
  }

  async function reorderWorkViewEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseReorderWorkViewRequest(await readJsonObject(request));
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === body.key);
    if (!stored) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${body.key}`);
    await presentationStore.reorderWorkView(workspaceId, stored.reference, body.index);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) return jsonResponse({ workViews: workViewSummaries(workspaceId, await presentationStore.listWorkViews(workspaceId)) });
    return turboStreamResponse("");
  }

  async function closeWorkViewJsonEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseCloseWorkViewRequest(await readJsonObject(request));
    return await closeWorkViewEndpoint(workspaceId, JSON.stringify(body.reference), request);
  }

  async function createWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    await serializePresentationMutation(workspaceId, async () => {
      await openAvailableWorkView(workspaceId, reference);
      invalidatePresentation();
    });
  }

  async function presentWorkViewFromAgent(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    await serializePresentationMutation(workspaceId, async () => {
      const { key } = await openAvailableWorkView(workspaceId, reference);
      registry.setParked(workspaceId, false);
      registry.requestSurfaceAttention(workspaceId, key);
      workPresentationIntents.set(workspaceId, { key, revision: crypto.randomUUID() });
      invalidatePresentation();
    });
  }

  async function requestWorkViewAttentionEndpoint(workspaceId: string, key: string, request: Request): Promise<Response> {
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === key);
    if (!stored) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${key}`);
    registry.setParked(workspaceId, false);
    registry.requestSurfaceAttention(workspaceId, key);
    return requestAcceptsJson(request) && !wantsTurboStream(request) ? jsonResponse({ attention: stored.reference }) : turboStreamResponse("");
  }

  async function closeAgentConversationEndpoint(workspaceId: string, conversationId: string, request: Request): Promise<Response> {
    requireWorkspace(workspaceId);
    const before = await agentTabs.list({ workspaceId });
    if (!before.some(agent => agent.id === conversationId)) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
    await agentTabs.close({ workspaceId, conversationId });
    registry.clearSurfaceAttention(workspaceId, `agent:${conversationId}`);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) {
      const agents = await agentPaneContributions(workspaceId);
      return jsonResponse({ archivedConversationId: conversationId, agentConversations: agents.map(({ id, title, providerId, busy, requestingAttention }) => ({ id, title, providerId, busy, requestingAttention })) });
    }
    return turboStreamResponse("");
  }

  async function renderModelPickerUpdates(request: Request): Promise<string> {
    const launchUpdates = (await Promise.all(agentProviders.map(provider => provider.launch.refreshConfiguration?.(launchComposerSettingsFrameId)))).join("");
    return requestAcceptsJson(request) && !wantsTurboStream(request) ? "" : launchUpdates;
  }

  function openOldestAttentionWorkspaceEndpoint(): Response {
    const entry = registry.oldestAttentionWorkspace();
    if (!entry) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return turboStreamResponse("", { headers: { location: `/workspaces/${encodeURIComponent(entry.id)}` } });
  }

  // ---------------------------------------------------------------------------
  // Errors + routing
  // ---------------------------------------------------------------------------

  function errorPage(error: Error): Response {
    const status = httpErrorStatus(error);
    const message = error.message;
    const backLink = actionLinkHtml({ href: "/", variant: "secondary", content: { kind: "caption", caption: "Back home" } });
    return response(layout(`<div class="app no-sidebar"><div class="main"><header class="header"><h1>Error</h1></header><div class="body"><p>${escapeHtml(message)}</p><p>${backLink}</p></div></div></div>`), { status });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/up" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : "ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const page = await homePage();
      return request.method === "HEAD" ? new Response(null, { status: page.status, statusText: page.statusText, headers: page.headers }) : page;
    }
    if (url.pathname === "/agent-providers" && request.method === "GET") {
      const providers = await orderedAgentProviders();
      return jsonResponse({ defaultProviderId: providers[0]!.id, providers: providers.map(({ id, label }) => ({ id, label })) });
    }
    if (url.pathname === "/openapi.json" && request.method === "GET") return jsonResponse(atelierOpenApi(workspaceModuleCommands(), Object.assign({}, ...workspaceModules.map((module) => module.openApiPaths ?? {}))));
    if (url.pathname === "/launch-composer" && request.method === "GET") return response(await renderProjectlessLaunchComposerFrame());
    if (url.pathname === "/launch-composer/provider" && request.method === "GET") return response(await renderLaunchProvider(agentProvider(url.searchParams.get("provider") ?? "builtin"), await orderedAgentProviders(), launchComposerFooterContext()));
    if (url.pathname === "/launch-composer/settings" && request.method === "GET") return response(await agentProvider(url.searchParams.get("provider") ?? "builtin").launch.renderFooter(launchComposerFooterContext(url.searchParams)));
    const projectOnboardingMatch = url.pathname.match(/^\/projects\/([^/]+)\/onboarding$/);
    if (projectOnboardingMatch && request.method === "GET") {
      const projectId = decodeURIComponent(projectOnboardingMatch[1]!);
      return projectEditorResponse(request, { kind: "onboarding", projectId });
    }
    const secretValueMatch = url.pathname.match(/^\/projects\/([^/]+)\/secrets\/([^/]+)\/value$/);
    if (secretValueMatch && request.method === "GET") {
      const projectId = decodeURIComponent(secretValueMatch[1]!);
      const secretId = decodeURIComponent(secretValueMatch[2]!);
      const purpose = url.searchParams.get("purpose") ?? undefined;
      return projectEditorResponse(request, { kind: "secret-value", projectId, secretId, purpose });
    }
    const projectSettingsMatch = url.pathname.match(/^\/projects\/([^/]+)\/settings$/);
    if (projectSettingsMatch && request.method === "GET") {
      const projectId = decodeURIComponent(projectSettingsMatch[1]!);
      const section = url.searchParams.get("section") ?? undefined;
      return projectEditorResponse(request, { kind: "settings", projectId, section });
    }
    const projectWorkspaceMatch = url.pathname.match(/^\/projects\/([^/]+)\/workspaces\/new$/);
    if (projectWorkspaceMatch && request.method === "GET") return await surfacePage({ kind: "new-workspace", project: await projectRoutes.byReference(decodeURIComponent(projectWorkspaceMatch[1]!)) });
    if (url.pathname === "/workspaces/new" && request.method === "GET") return await surfacePage({ kind: "new-workspace" });
    if (url.pathname === "/projects/new" && request.method === "GET") {
      return projectEditorResponse(request, { kind: "new" });
    }
    if (url.pathname === "/settings" && request.method === "GET" && !wantsTurboStream(request)) return await surfacePage({ kind: "settings", section: url.searchParams.get("section") ?? undefined });
    if (url.pathname === "/settings/development" && request.method === "GET" && !wantsTurboStream(request)) return await surfacePage({ kind: "settings", section: undefined, development: true });
    if (url.pathname === "/workspaces" && request.method === "GET") return workspaceListEndpoint(request, url);
    if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceEndpoint(request);
    if (url.pathname === "/workspaces/open-oldest-attention" && request.method === "POST") return openOldestAttentionWorkspaceEndpoint();

    const projectResponse = await projectRoutes.handle(request, url);
    if (projectResponse) return projectResponse;

    const match = (pattern: RegExp): string[] | undefined => {
      const result = url.pathname.match(pattern);
      return result ? result.slice(1).map(decodeURIComponent) : undefined;
    };
    const routeParam = (values: string[], index: number): string => {
      const value = values[index];
      if (value === undefined) throw new Error(`Route parameter ${index} is missing`);
      return value;
    };

    const settingsResponse = await handleSettingsRequest(request, url, { forceDeleteAllWorkspaces: forceDeleteAllWorkspacesFromSettings, renderModelPickerUpdates: () => renderModelPickerUpdates(request) });
    if (settingsResponse) return settingsResponse;

    const onboardingResponse = await handleOnboardingRequest(request, url);
    if (onboardingResponse) return onboardingResponse;

    for (const moduleRoute of workspaceModuleRoutes()) {
      const moduleResponse = await moduleRoute.handle(request, url, {
        events: deps.events,
        renderModalPage: (dialogHtml) => surfacePage({ kind: "module-modal", dialogHtml }),
        openWorkView: (workspaceId, reference, options) => openWorkspaceModuleWorkView(workspaceId, reference, request, options),
      });
      if (moduleResponse) return moduleResponse;
    }

    let params: string[] | undefined;

    if ((params = match(/^\/workspaces\/([^/]+)\/file\/open$/))) {
      if (request.method !== "GET") return response("Method not allowed", { status: 405, headers: { allow: "GET" } });
      return await openWorkspaceFile(routeParam(params, 0), parseWorkspaceFileTarget(url.searchParams),
        (workspaceId, reference) => openWorkspaceModuleWorkView(workspaceId, reference, request));
    }

    if (url.pathname === "/agent-workspaces" && request.method === "POST") return await createEmptyAgentWorkspaceEndpoint(request);

    if ((params = match(/^\/workspaces\/([^/]+)\/sidebar-title$/)) && request.method === "POST") return await updateWorkspaceSidebarTitle(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const commandId = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await workspaceCommandEndpoint(workspaceId, commandId, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const conversationId = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await closeAgentConversationEndpoint(workspaceId, conversationId, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      return await serializePresentationMutation(workspaceId, async () => await closeWorkViewJsonEndpoint(workspaceId, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/(.+)\/attention\/request$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const key = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await requestWorkViewAttentionEndpoint(workspaceId, key, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/(.+)\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const reference = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await closeWorkViewEndpoint(workspaceId, reference, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/reorder$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      return await serializePresentationMutation(workspaceId, async () => await reorderWorkViewEndpoint(workspaceId, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/park$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], true, request);
    if ((params = match(/^\/workspaces\/([^/]+)\/unpark$/)) && request.method === "POST") return parkWorkspaceEndpoint(params[0], false, request);
    if ((params = match(/^\/workspaces\/([^/]+)\/warnings\/([^/]+)\/dismiss$/)) && request.method === "POST") return dismissWorkspaceWarning(params[0], params[1], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/provisioning\/continue$/)) && request.method === "POST") return continueWorkspaceProvisioningEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete\/cancel$/)) && request.method === "POST") return await cancelWorkspaceDeletionEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete\/confirm$/)) && request.method === "POST") return await confirmWorkspaceDeletionEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete\/retry$/)) && request.method === "POST") return await retryWorkspaceDeletionEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteWorkspaceEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)$/)) && request.method === "GET") return await workspacePage(params[0], request);

    return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return {
    subscribeShell: listener => shell.subscribe(listener),
    subscribeSurface,
    invalidateWorkspace,
    deleteCurrentWorkspaceFromAgent,
    resumeWorkspaceDeletions: deletion.resume,
    provisioning,
    async createWorkspaceFromAgent(init, title, signal, onUpdate) {
      signal?.throwIfAborted();
      const { id } = await createWorkspaceFromCommand({ init, title });
      const identity = { workspaceId: id, url: `/workspaces/${id}` };
      while (true) {
        signal?.throwIfAborted();
        const entry = registry.get(id);
        const snapshot = provisioning.snapshot(id);
        const progress = JSON.stringify({ ...identity, provisioning: snapshot });
        onUpdate?.({ content: [{ type: "text", text: progress }], details: identity });
        if (!entry || entry.phase.kind === "runningPhase" || (entry.phase.kind === "provisioningPhase" && entry.phase.status === "failed") || snapshot?.status === "waiting") {
          return {
            ...identity, status: !entry ? "deleted" : entry.phase.kind === "runningPhase" ? "ready" : snapshot?.status === "waiting" ? "awaiting_user" : "failed",
            error: entry?.phase.error ?? snapshot?.error,
            settings: init.settings,
            timings: { totalMs: snapshot?.totalMs, phases: snapshot?.steps.map(({ id, label, durationMs, status, error }) => ({ id, label, durationMs, status, error })) ?? [] },
          };
        }
        await delay(250, undefined, { signal });
      }
    },
    createWorkView,
    presentWorkViewFromAgent,
    globalSidebarContributions,
    async fetch(request) {
      try {
        const result = await route(request);
        if (request.method !== "GET" && request.method !== "HEAD") {
          invalidateWorkspace(new URL(request.url).pathname.match(/^\/workspaces\/([^/]+)/)?.[1]);
        }
        return result;
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        if (error instanceof AtelierCoreError && error.code === "agent_setup_required" && !requestAcceptsJson(request)) {
          const setup = await route(new Request(new URL(String(error.details!.setupUrl), request.url), { headers: { accept: "text/vnd.turbo-stream.html" } }));
          // A rejected launch must keep its prompt and attachment draft intact.
          return new Response(setup.body, { status: 422, headers: setup.headers });
        }
        return requestAcceptsJson(request) ? problemJsonResponse(error) : errorPage(error);
      }
    },
  };
}
