import {
  prepareNewWorkspaceAgentParameters,
  renderLaunchComposer,
  renderLaunchComposerSettings,
  rememberNewWorkspaceAgentSettings,
} from "@atelier/agent/server";
import {
  AtelierCoreError,
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
import { Icons } from "@atelier/design-system/icons";
import { isGitProjectInit, listProjects, projectWorkspaceInit, type ProjectSummary } from "@atelier/projects";
import { createWorkspacePresentationStore, generateWorkspaceId, listWorkspaces, setWorkspaceParked, setWorkspaceTitle, type WorkspaceCreationContext, type WorkspaceInitInstruction, type WorkspaceWorkViewReference, type WorkspaceWorkViewState } from "@atelier/workspace";
import { createWorkspaceProvisioningStore } from "@atelier/workspace/server/provisioning";
import {
  atelierCableConnectionHeader,
  CableTopics,
  emptyWorkspaceCommandInputSchema,
  domId,
  escapeHtml,
  turboStreamResponse,
  type AgentWorkspaceParameters,
  type CableIdentifier,
  type DeleteCurrentWorkspaceResult,
  type GlobalSidebarContributionRegistry,
  type WorkspaceAttachment,
  type WorkspaceModuleCommandHandler,
  type WorkspaceModuleCommandResult,
  type WorkspaceModuleRouteHandler,
  type WorkspaceModuleWorkViewAdapter,
  type WorkspaceDeletionReview,
  type WorkspaceServerProvisioningHook,
  type WorkspaceAgentTabProvider,
  type WorkspaceWorkViewPresentation,
} from "@atelier/shared";
import type { WorkspaceDeletionState, WorkspaceEntry, WorkspaceRegistry } from "./workspace-registry.ts";
import { workspaceModules } from "./workspace-modules.ts";
import { handleSettingsRequest, renderDevelopmentSettingsDialog, renderSettingsDialog } from "./settings/routes.ts";
import { handleOnboardingRequest, renderOnboardingDialog } from "./onboarding/routes.ts";
import { atelierOpenApi } from "./openapi.ts";
import { parseCloseWorkViewRequest, parseReorderWorkViewRequest } from "./work-view-api.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentTabsTurboStream, openWorkViewTurboStream, presentWorkViewTurboStream, removeWorkspaceResidentTurboStream, renderAgentBodyFrame, renderAtelierBar, renderMobileWorkspaceBar, renderWorkViewBodyFrame, renderWorkspaceDeletionPresentation, renderWorkspacePane, renderWorkspacePresentation, selectAgentTurboStream, workspacePaneCollectionsTurboStream, workspacePaneOnboardingState, workspacePreparationInvalidatedTurboStream, workspacePresentationDomId, workViewsTurboStream, type AgentPaneContribution, type WorkPaneContribution, type WorkspacePaneEntry, type WorkspacePanePresentation, type WorkspacePresentation as FixedWorkspacePresentation } from "./workspace-presentation.ts";
import type { CableBroadcastOptions } from "./cable.ts";
import { jsonResponse, problemJsonResponse, response, turboReplaceStream, turboUpdateStream, wantsTurboStream } from "./http-responses.ts";
import { createPageLayout } from "./page-layout.ts";
import { createProjectRoutes } from "./project-routes.ts";
import { createWorkspaceDeletion } from "./workspace-deletion.ts";

const jsonStringSchema = Type.String();
const attentionTokensSchema = Type.Record(Type.String(), Type.Integer({ minimum: 1 }));

function attentionTokens(request: Request): Record<string, number> {
  const raw = new URL(request.url).searchParams.get("attentionTokens");
  let parsed: unknown;
  try {
    parsed = raw === null ? undefined : JSON.parse(raw);
  } catch {
    throw invalidArguments("attentionTokens must be a valid view-token map");
  }
  if (!Value.Check(attentionTokensSchema, parsed)) throw invalidArguments("attentionTokens must be a valid view-token map");
  return parsed;
}

export interface WebAppDeps {
  registry: WorkspaceRegistry;
  cable?: { broadcast(identifier: CableIdentifier, html: string, options?: CableBroadcastOptions): void };
  /** Event bus passed through to the agent module routes. */
  events?: AtelierEventBus;
  devReload?: boolean;
  /** Create the container + default agent etc. for an already-registered workspace id. */
  provisionWorkspace(id: string, options?: { init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; waitForContinue(stepId: string): Promise<void> }): Promise<void>;
  /** Test/embedding override. Production obtains this contribution from the Review module. */
  deletionReview?: WorkspaceDeletionReview;
  /** Force-remove the workspace container. */
  destroyWorkspace(id: string): Promise<void>;
  /** Persist parked state and stop or start its workspace container. Defaults to setWorkspaceParked. */
  persistWorkspaceParked?(id: string, parked: boolean): Promise<void>;
  /** Receives background task failures. Defaults to console.error. */
  logError?(message: string): void;
  provisioningHooks: WorkspaceServerProvisioningHook[];
  workspaceRemovedHandlers?: Array<(workspaceId: string) => void | Promise<void>>;
}

export interface WebApp {
  fetch(request: Request): Promise<Response>;
  shellSnapshot(): Promise<string>;
  deleteCurrentWorkspaceFromAgent(workspaceId: string, force: boolean): Promise<DeleteCurrentWorkspaceResult>;
  resumeWorkspaceDeletions(): void;
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
    changed(id, state) {
      if (state.status === "blocked") return broadcastBlockedDeletion(id, state);
      if (state.status === "failed" && state.operation === "deleting") logError(`could not delete workspace ${id}: ${state.error}`);
      broadcastDeletionPresentation(id);
    },
  });
  // SAFETY: Workspace modules expose this exact shared Agent-tab provider contract.
  const agentTabProviders = workspaceModules.flatMap((module) => module.agentTabs ? [module.agentTabs] : []) as WorkspaceAgentTabProvider[];
  if (agentTabProviders.length !== 1) throw new Error(`Expected exactly one Workspace Agent-tab provider, found ${agentTabProviders.length}`);
  const agentTabs = agentTabProviders[0]!;
  const presentationStore = createWorkspacePresentationStore({
    workViewContributions: workViewAdapters,
  });
  const presentationMutationQueues = new Map<string, Promise<void>>();

  async function serializePresentationMutation<Result>(workspaceId: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = presentationMutationQueues.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    presentationMutationQueues.set(workspaceId, settled);
    void settled.then(() => {
      if (presentationMutationQueues.get(workspaceId) === settled) presentationMutationQueues.delete(workspaceId);
    });
    return await result;
  }

  function broadcastShell(html: string, options?: CableBroadcastOptions): void {
    deps.cable?.broadcast(CableTopics.shell(), html, options);
  }

  function deliverShellMutation(request: Request, structuralHtml: string, originHtml = ""): string {
    if (structuralHtml) broadcastShell(structuralHtml);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) return "";
    const originConnectionId = request.headers.get(atelierCableConnectionHeader);
    if (!deps.cable || !originConnectionId) return `${structuralHtml}${originHtml}`;
    if (originHtml) broadcastShell(originHtml, { onlyConnectionId: originConnectionId });
    return "";
  }

  deps.events?.on("workspace_agent_view_invalidated", ({ workspaceId, conversationId, exceptConnectionId, html }) => {
    broadcastShell(`${html ?? ""}${workspacePreparationInvalidatedTurboStream(workspaceId, conversationId)}`, exceptConnectionId ? { exceptConnectionId } : undefined);
  });
  deps.events?.on("workspace_agent_turn_finished", ({ workspaceId, conversationId }) => {
    broadcastShell(selectAgentTurboStream(workspaceId, conversationId));
  });
  deps.events?.on("workspace_agent_conversation_title_changed", async ({ workspaceId }) => {
    broadcastShell(agentTabsTurboStream(await fixedWorkspacePresentation(workspaceId)));
  });

  const provisioning = createWorkspaceProvisioningStore({ onChange: (workspaceId) => broadcastWorkspaceBoot(workspaceId), seedSteps: deps.provisioningHooks });
  const provisioningContinuations = new Map<string, { stepId: string; resolve(): void }>();
  const workspaceCommandModalHostId = "workspace_command_modal_host";
  const launchComposerFrameId = "launch_composer";
  // Every server-rendered LaunchComposer has one attachment draft ID. Retried POSTs
  // therefore join the original launch instead of provisioning another Workspace.
  const launchComposerSubmissions = new Map<string, Promise<CreatedWorkspace>>();
  const launchComposerSettingsFrameId = "launch_composer_settings";
  const launchComposerFormId = "launch_composer_form";
  const projectRoutes = createProjectRoutes({
    referencingWorkspaces: (projectId) => registry.list()
      .filter((entry) => isGitProjectInit(entry.init) && entry.init.projectId === projectId)
      .map((entry) => ({ workspaceId: entry.id, title: workspaceTitle(entry) })),
    refreshWorkspacePaneCollections,
    renderLaunchComposer: renderProjectLaunchComposerFrame,
    createAgentWorkspace: async (project, request) => await createAgentWorkspaceFromForm(request, { project }),
    workspaceCommandModalHostId,
  });

  function workspaceBootId(id: string): string {
    return domId("workspace_boot", id);
  }

  const globalSidebarContributionStore = new Map<string, string>();

  function renderGlobalSidebarContributions(): string {
    return Array.from(globalSidebarContributionStore.values()).filter(Boolean).join("");
  }

  const globalSidebarContributions: GlobalSidebarContributionRegistry = {
    set(contributionId: string, html?: string, options = {}) {
      if (html) globalSidebarContributionStore.set(contributionId, html);
      else globalSidebarContributionStore.delete(contributionId);
      const streamHtml = `${turboUpdateStream("global_sidebar_contributions", renderGlobalSidebarContributions(), { method: "morph" })}${options.broadcastHtml ?? ""}`;
      broadcastShell(streamHtml);
    },
  };

  function workspaceTitle(entry: WorkspaceEntry): string {
    return entry.title || (isGitProjectInit(entry.init) ? entry.init.name : undefined) || `Workspace ${entry.id}`;
  }

  const persistWorkspaceParked = deps.persistWorkspaceParked ?? setWorkspaceParked;
  let suppressParkedStateCallbacks = false;

  async function refreshWorkspacePaneCollections(): Promise<string> {
    const pane = await workspacePaneCollections("");
    const stream = `${workspacePaneCollectionsTurboStream(pane)}${turboReplaceStream(emptyWorkspaceOnboardingId, emptyWorkspaceOnboardingHtml(pane))}`;
    broadcastShell(stream);
    return stream;
  }

  function broadcastWorkspacePaneCollections(): void {
    void refreshWorkspacePaneCollections().catch((error) => logError(`could not refresh Workspace pane: ${error instanceof Error ? error.message : String(error)}`));
  }

  registry.setCallbacks({
    rowChanged(entry, context) {
      broadcastWorkspacePaneCollections();
      if (context.viewKey) broadcastShell(workspacePreparationInvalidatedTurboStream(entry.id));
    },
    listChanged() {
      if (suppressParkedStateCallbacks) return;
      broadcastWorkspacePaneCollections();
    },
    parkedChanged(entry) {
      if (suppressParkedStateCallbacks) return;
      void persistWorkspaceParked(entry.id, entry.parked).catch((error) => logError(`could not persist parked state for workspace ${entry.id}: ${error instanceof Error ? error.message : String(error)}`));
    },
    removed(id) {
      provisioning.delete(id);
      broadcastShell(removeWorkspaceResidentTurboStream(id));
      for (const handler of deps.workspaceRemovedHandlers ?? []) void handler(id);
    },
  });

  // ---------------------------------------------------------------------------
  // Page shell
  // ---------------------------------------------------------------------------

  const layout = createPageLayout({ devReload: deps.devReload, workspaceModules });

  async function launchComposerSettingsFrame(selectedModel?: string): Promise<string> {
    return await renderLaunchComposerSettings({
      frameId: launchComposerSettingsFrameId,
      formId: launchComposerFormId,
      url: "/launch-composer/settings",
      selectedModel,
    });
  }

  async function renderLaunchComposerFrame(options: { titleHtml: string; action: string }): Promise<string> {
    const draftId = crypto.randomUUID();
    const closeButton = buttonHtml({
      type: "submit",
      variant: "secondary",
      content: { kind: "icon-only", iconHtml: Icons.Close, label: "Close launch composer" },
    });
    return `<turbo-frame id="${launchComposerFrameId}"><dialog class="launch-composer-dialog" data-controller="launch-composer-dialog submit-shortcut" data-launch-composer-dialog-discard-url-value="/agent-attachment-drafts/${encodeURIComponent(draftId)}/discard">
  <header class="launch-composer-header">
    <div class="launch-composer-title">${options.titleHtml}</div>
    <form method="dialog">${closeButton}</form>
  </header>
  ${await renderLaunchComposer({
    action: options.action,
    draftId,
    formId: launchComposerFormId,
    placeholder: "Describe what you want the agent to do… (optional)",
    initialText: "",
    rows: 8,
    formActions: "keydown->submit-shortcut#keydown submit->submit-shortcut#submit submit->launch-composer-dialog#submit turbo:submit-end->submit-shortcut#submitted",
    formTurbo: true,
    launchComposerSettings: { frameId: launchComposerSettingsFrameId, url: "/launch-composer/settings" },
  })}
</dialog></turbo-frame>`;
  }

  async function renderProjectlessLaunchComposerFrame(): Promise<string> {
    return await renderLaunchComposerFrame({
      titleHtml: "Create empty workspace, and then…",
      action: "/agent-workspaces",
    });
  }

  async function renderProjectLaunchComposerFrame(project: ProjectSummary): Promise<string> {
    return await renderLaunchComposerFrame({
      titleHtml: `Create workspace from <b>${escapeHtml(project.name)}</b>, and then…`,
      action: `/project-agent-workspaces/${encodeURIComponent(project.id)}`,
    });
  }


  // ---------------------------------------------------------------------------
  // Workspace detail residency host
  // ---------------------------------------------------------------------------

  async function attachWorkspaceModules(workspaceId: string): Promise<WorkspaceAttachment[]> {
    const entry = requireWorkspace(workspaceId);
    return await Promise.all(workspaceModules
      .filter((module) => module.attachToWorkspace)
      .map((module) => module.attachToWorkspace!({ workspaceId, init: entry.init, events: deps.events })));
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
    const { projects: savedProjects } = await listProjects();
    const projectTitles = new Map(savedProjects.map((project) => [project.id, project.name]));
    const grouped = new Map<string, WorkspaceEntry[]>();
    const parkedByProject = new Map<string, WorkspaceEntry[]>();
    const projectless: WorkspaceEntry[] = [];
    const projectlessParked: WorkspaceEntry[] = [];
    for (const entry of registry.list()) {
      if (!isGitProjectInit(entry.init)) {
        (entry.parked ? projectlessParked : projectless).push(entry);
        continue;
      }
      const destination = entry.parked ? parkedByProject : grouped;
      destination.set(entry.init.projectId, [...(destination.get(entry.init.projectId) ?? []), entry]);
    }
    const paneEntry = (entry: WorkspaceEntry): WorkspacePaneEntry => {
      const deletionStatus = entry.deletion?.status;
      const pane: WorkspacePaneEntry = {
        id: entry.id,
        title: workspaceTitle(entry),
        active: entry.id === activeWorkspaceId,
        state: entry.phase === "starting"
          ? "starting"
          : deletionStatus === "checking" || deletionStatus === "deleting"
            ? "deleting"
            : deletionStatus === "blocked"
              ? "requires_delete_confirmation"
              : "idle",
        attention: registry.hasAttention(entry.id),
        lastActivityAt: entry.lastActivityAt,
        busyViewKeys: registry.busyViews(entry.id),
        outdated: entry.imageOutdated,
      };
      const attentionAt = registry.workspaceAttentionAt(entry.id);
      if (attentionAt !== undefined) pane.attentionAt = attentionAt;
      const tokens = registry.attentionTokens(entry.id);
      if (Object.keys(tokens).length > 0) pane.attentionTokens = tokens;
      return pane;
    };
    const workspaceProjectIds = new Set([...grouped.keys(), ...parkedByProject.keys()]);
    return {
      projects: [...workspaceProjectIds].map((id) => {
        const entries = grouped.get(id) ?? [];
        const parkedEntries = parkedByProject.get(id) ?? [];
        const init = (entries[0] ?? parkedEntries[0])!.init;
        if (!isGitProjectInit(init)) throw new Error(`Project ${id} contains a projectless Workspace`);
        return { id, title: projectTitles.get(id) ?? init.name, workspaces: entries.map(paneEntry), parkedWorkspaces: parkedEntries.map(paneEntry) };
      }),
      emptyProjects: savedProjects.filter((project) => !workspaceProjectIds.has(project.id)).map((project) => ({ id: project.id, title: project.name })),
      projectlessWorkspaces: projectless.map(paneEntry),
      projectlessParkedWorkspaces: projectlessParked.map(paneEntry),
    };
  }

  function workViewPresentations(workspaceId: string, currentWorkViews: readonly WorkspaceWorkViewPresentation[], storedWorkViews: readonly WorkspaceWorkViewState[]): WorkPaneContribution[] {
    const currentByKey = new Map(currentWorkViews.map((view) => [workViewKey(view.reference), view]));
    return storedWorkViews.map((stored) => {
      const key = workViewKey(stored.reference);
      const contribution = currentByKey.get(key);
      const view: WorkPaneContribution = {
        key,
        label: contribution?.label ?? `${stored.reference.type} unavailable`,
        kind: contribution?.kind ?? "resource",
        availability: contribution?.availability ?? { phase: "unavailable", detail: "The referenced resource is not currently available." },
        close: workViewClose(workspaceId, stored.reference, contribution?.label ?? stored.reference.type),
      };
      if (contribution?.sourceKey !== undefined) view.sourceKey = contribution.sourceKey;
      if (contribution) view.bodyUrl = `/workspaces/${encodeURIComponent(workspaceId)}/work-views/${encodeURIComponent(key)}/body`;
      if (contribution?.actionsHtml !== undefined) view.actionsHtml = contribution.actionsHtml;
      if (stored.attentionSequence !== undefined) view.attentionSequence = stored.attentionSequence;
      return view;
    });
  }

  async function workspacePresentationBundle(workspaceId: string): Promise<{
    presentation: FixedWorkspacePresentation;
    attachments: WorkspaceAttachment[];
    storedWorkViews: WorkspaceWorkViewState[];
  }> {
    const entry = requireWorkspace(workspaceId);
    const attachments = await attachWorkspaceModules(workspaceId);
    const agentConversations = await agentTabs.list({ workspaceId });
    const currentWorkViews = attachments.flatMap((attachment) => attachment.workViews ?? []);
    await presentationStore.initialize(workspaceId, currentWorkViews.filter((view) => view.initiallyOpen !== false).map((view) => view.reference));
    const storedWorkViews = await presentationStore.listWorkViews(workspaceId);
    const commands = attachments.flatMap((attachment) => attachment.commands ?? []).map((command) => ({
      id: command.id, label: command.surfaces?.ui?.label ?? command.label, description: command.description, scope: command.scope, placement: command.surfaces?.ui?.placement, binding: command.surfaces?.shortcut?.defaultBinding,
    }));
    const presentation: FixedWorkspacePresentation = {
      workspace: { id: entry.id, title: workspaceTitle(entry) },
      agentConversations: agentConversations.map((conversation) => {
        const presented: AgentPaneContribution = { id: conversation.id, title: conversation.title, bodyUrl: `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(conversation.id)}/body` };
        if (agentConversations.length > 1) presented.close = agentClose(workspaceId, conversation.id, conversation.title);
        return presented;
      }),
      workViews: workViewPresentations(workspaceId, currentWorkViews, storedWorkViews),
      commands,
      overlayHtml: attachments.flatMap((attachment) => attachment.overlayHtml ?? []),
    };
    return { presentation, attachments, storedWorkViews };
  }

  async function fixedWorkspacePresentation(workspaceId: string): Promise<FixedWorkspacePresentation> {
    return (await workspacePresentationBundle(workspaceId)).presentation;
  }

  async function workspaceDetailContent(id: string): Promise<string> {
    const entry = requireWorkspace(id);
    return entry.deletion ? deletionPresentation(entry, entry.deletion) : renderWorkspacePresentation(await fixedWorkspacePresentation(id));
  }

  async function workspaceDetailResidentHtml(id: string, options: { visible?: boolean } = {}): Promise<string> {
    const entry = requireWorkspace(id);
    const projectAttr = isGitProjectInit(entry.init) ? ` data-project-id="${escapeHtml(entry.init.projectId)}"` : "";
    return `<div class="workspace-detail-resident ${options.visible ? "visible" : ""}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(id)}"${projectAttr}>${await workspaceDetailContent(id)}</div>`;
  }

  function workspaceBootResidentHtml(entry: WorkspaceEntry, options: { visible?: boolean } = {}): string {
    const deleteButton = buttonHtml({ type: "submit", variant: "danger", content: { kind: "caption", caption: "Delete workspace" } });
    const deleteAction = entry.phase === "failed" ? `<form class="fixed-shell-delete-workspace" method="post" action="/workspaces/${encodeURIComponent(entry.id)}/delete">${deleteButton}</form>` : "";
    const inner = `${provisioning.render(entry.id, { failed: entry.phase === "failed", error: entry.error })}${deleteAction}`;
    const projectAttr = isGitProjectInit(entry.init) ? ` data-project-id="${escapeHtml(entry.init.projectId)}"` : "";
    return `<div class="workspace-detail-resident workspace-boot ${options.visible ? "visible" : ""}" id="${workspaceBootId(entry.id)}" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(entry.id)}"${projectAttr}><div class="main"><div class="body"><div class="workspace-boot-content">${inner}</div></div></div>${renderMobileWorkspaceBar()}</div>`;
  }

  function broadcastWorkspaceBoot(id: string): void {
    const entry = registry.get(id);
    if (!entry || (entry.phase !== "starting" && entry.phase !== "failed")) return;
    broadcastShell(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
  }

  deps.events?.on("workspace_provision_step", (event) => provisioning.apply(event));

  async function workspaceResidentFor(entry: WorkspaceEntry, options: { visible?: boolean } = {}): Promise<string> {
    if (!entry.deletion && (entry.phase === "starting" || entry.phase === "failed")) return workspaceBootResidentHtml(entry, options);
    return await workspaceDetailResidentHtml(entry.id, options);
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

  async function workspaceDetailHostHtml(pane: WorkspacePanePresentation, selectedId?: string): Promise<string> {
    const entry = selectedId ? registry.get(selectedId) : undefined;
    const resident = entry ? await workspaceResidentFor(entry, { visible: true }) : "";
    return `<div id="workspace_detail" class="workspace-detail-host" data-controller="workspace-residency" data-workspace-residency-max-resident-value="5">
      <div class="workspace-detail-empty" data-workspace-residency-target="empty"${resident ? " hidden" : ""}>${emptyWorkspaceOnboardingHtml(pane)}</div>
      <div class="workspace-detail-loading" data-workspace-residency-target="loading" hidden><div class="workspace-detail-loading-status" role="status"><span class="status-spinner" aria-hidden="true"></span><span>Loading workspace…</span></div></div>
      ${resident}
    </div>`;
  }

  type ShellSurface =
    | { kind: "project-settings"; projectId: string; section: string | undefined }
    | { kind: "new-project" }
    | { kind: "new-workspace"; project?: ProjectSummary }
    | { kind: "settings"; section: string | undefined; development?: true };

  async function renderWorkspaceShell(selectedId?: string, surface?: ShellSurface): Promise<string> {
    const pane = await workspacePaneCollections(selectedId ?? "");
    const projectEditor = surface?.kind === "project-settings"
      ? await projectRoutes.editorModal({ kind: "settings", projectId: surface.projectId, section: surface.section })
      : await projectRoutes.editorModal(surface?.kind === "new-project" ? { kind: "new" } : undefined);
    const settings = surface?.kind === "settings"
      ? surface.development ? await renderDevelopmentSettingsDialog() : await renderSettingsDialog(surface.section)
      : "";
    const launchComposer = surface?.kind === "new-workspace"
      ? surface.project ? await renderProjectLaunchComposerFrame(surface.project) : await renderProjectlessLaunchComposerFrame()
      : `<turbo-frame id="${launchComposerFrameId}"></turbo-frame>`;
    return `<div class="app fixed-shell-app" data-controller="atelier-shortcuts workspace-navigation">
    ${renderWorkspacePane(pane, renderGlobalSidebarContributions())}
    <main class="fixed-shell-app-main">${await workspaceDetailHostHtml(pane, selectedId)}</main>
    ${renderAtelierBar(pane)}
  </div>
  ${projectEditor}
  <div id="update_modal_host"></div>
  <div id="settings_modal_host">${settings}</div>
  <div id="onboarding_modal_host">${await renderOnboardingDialog()}</div>
  <div id="${workspaceCommandModalHostId}"></div>
  ${launchComposer}`;
  }

  async function homePage(): Promise<Response> {
    const selected = registry.list().find((entry) => !entry.parked);
    return response(layout(await renderWorkspaceShell(selected?.id)));
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

  async function workspaceJson(id: string): Promise<Response> {
    const entry = requireWorkspace(id);
    const workspace: Pick<WorkspaceEntry, "id" | "phase" | "parked" | "error"> & { title: string; url: string } = {
      id: entry.id,
      title: workspaceTitle(entry),
      phase: entry.phase,
      parked: entry.parked,
      url: `/workspaces/${encodeURIComponent(entry.id)}`,
    };
    if (entry.error) workspace.error = entry.error;
    if (entry.deletion || entry.parked || entry.phase !== "ready") return jsonResponse({ workspace });

    const { presentation, storedWorkViews, attachments } = await workspacePresentationBundle(id);
    const handlers = new Map(workspaceModuleCommands().map((handler) => [handler.id, handler]));
    return jsonResponse({ workspace: {
      ...workspace,
      agentConversations: presentation.agentConversations.map(({ id, title }) => ({ id, title })),
      workViews: storedWorkViews.map((workView) => ({ key: workViewKey(workView.reference), ...workView })),
      commands: attachments.flatMap((attachment) => attachment.commands ?? []).filter((command) => handlers.has(command.id)).map((command) => ({
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
      const workspace: Pick<WorkspaceEntry, "id" | "phase" | "parked"> & { title: string; projectId?: string } = {
        id: entry.id,
        title: workspaceTitle(entry),
        phase: entry.phase,
        parked: entry.parked,
      };
      if (isGitProjectInit(entry.init)) workspace.projectId = entry.init.projectId;
      return workspace;
    }) });
  }

  async function workspacePage(id: string, request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) return await workspaceJson(id);
    const entry = requireWorkspace(id);
    if (entry.parked) return Response.redirect(new URL("/", request.url).toString(), 302);
    const url = new URL(request.url);
    if (url.searchParams.get("resident") === "1") return response(await workspaceResidentFor(entry, { visible: true }));
    return response(layout(await renderWorkspaceShell(id)));
  }

  // ---------------------------------------------------------------------------
  // Create / delete
  // ---------------------------------------------------------------------------

  function waitForProvisioningContinue(workspaceId: string, stepId: string): Promise<void> {
    if (provisioningContinuations.has(workspaceId)) throw new Error(`workspace ${workspaceId} is already waiting for provisioning confirmation`);
    return new Promise((resolve) => provisioningContinuations.set(workspaceId, { stepId, resolve }));
  }

  function startWorkspaceProvisioning(id: string, options: { init?: WorkspaceInitInstruction; context?: WorkspaceCreationContext; title?: string } = {}): void {
    provisioning.seed(id);
    void (async () => {
      try {
        await deps.provisionWorkspace(id, { init: options.init, context: options.context, waitForContinue: (stepId) => waitForProvisioningContinue(id, stepId) });
        if (options.title) await setWorkspaceTitle(id, options.title);
        registry.setPhase(id, "ready");
        if (options.context?.agent && !options.context.agent.initialPrompt?.trim()) registry.markViewAttention(id, "workspace");
        await broadcastWorkspaceReady(id);
      } catch (error) {
        provisioningContinuations.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        logError(`could not provision workspace ${id}: ${message}`);
        registry.setPhase(id, "failed", message);
        registry.markViewAttention(id, "workspace");
        provisioning.apply({ workspaceId: id, id: "workspace.failed", label: "Workspace creation failed", status: "failed", error: message });
        const entry = registry.get(id);
        // No "visible" class in broadcasts: each client shows the resident
        // itself iff it is currently looking at this workspace.
        if (entry) broadcastShell(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
      }
    })();
  }

  type WorkspaceCreateSource = { type: "empty" } | { type: "project"; project: ProjectSummary };

  function initForSource(source: WorkspaceCreateSource): WorkspaceInitInstruction | undefined {
    return source.type === "project" ? projectWorkspaceInit(source.project) : undefined;
  }

  function agentContext(agent: AgentWorkspaceParameters | undefined): AgentWorkspaceParameters | undefined {
    const initialPrompt = agent?.initialPrompt?.trim() ?? "";
    const initialPromptMode = agent?.initialPromptMode;
    const model = agent?.model ?? "";
    const thinkingLevel = agent?.thinkingLevel ?? "";
    const serviceTier = agent?.serviceTier ?? "";
    const attachmentDraft = agent?.attachmentDraft ?? "";
    if (!initialPrompt && !initialPromptMode && !model && !thinkingLevel && !serviceTier && !attachmentDraft) return undefined;
    const parameters: AgentWorkspaceParameters = { initialPrompt, model, thinkingLevel, attachmentDraft };
    if (initialPromptMode) parameters.initialPromptMode = initialPromptMode;
    if (serviceTier) parameters.serviceTier = serviceTier;
    return parameters;
  }

  interface CreatedWorkspace {
    id: string;
    isFirstWorkspace: boolean;
  }

  async function createWorkspaceFromCommand(command: { source: WorkspaceCreateSource; agent?: AgentWorkspaceParameters; title?: string }): Promise<CreatedWorkspace> {
    const isFirstWorkspace = registry.list().length === 0;
    const id = generateWorkspaceId();
    const init = initForSource(command.source);
    const title = command.title?.trim() ?? "";
    const agent = agentContext(await prepareNewWorkspaceAgentParameters(command.agent));
    const context: WorkspaceCreationContext | undefined = agent ? { agent } : undefined;
    registry.add(id, title || null, init);
    const options: Parameters<typeof startWorkspaceProvisioning>[1] = {};
    if (init !== undefined) options.init = init;
    if (context) options.context = context;
    if (title) options.title = title;
    startWorkspaceProvisioning(id, options);
    return { id, isFirstWorkspace };
  }

  async function createWorkspaceEndpoint(url: URL, request: Request): Promise<Response> {
    if (requestAcceptsJson(request)) {
      const body = await readWorkspaceCreateJson(request);
      const sourceType = stringField(body.source?.type, "source.type") ?? "empty";
      if (sourceType !== "empty" && sourceType !== "project") throw invalidArguments("source.type must be empty or project");
      const projectReference = stringField(body.source?.project, "source.project");
      let source: WorkspaceCreateSource = { type: "empty" };
      if (sourceType === "project") {
        if (!projectReference) throw invalidArguments("source.project is required for project workspaces");
        source = { type: "project", project: await projectRoutes.byReference(projectReference) };
      }
      const agent = body.agent;
      const serviceTier = stringField(agent?.serviceTier, "agent.serviceTier");
      const { id } = await createWorkspaceFromCommand({
        source,
        title: stringField(body.title, "title"),
        agent: {
          initialPrompt: stringField(agent?.initialPrompt, "agent.initialPrompt") ?? "",
          model: stringField(agent?.model, "agent.model") ?? "",
          thinkingLevel: stringField(agent?.thinkingLevel, "agent.thinkingLevel") ?? "",
          serviceTier: serviceTier ? (serviceTier === "priority" ? "priority" : "default") : undefined,
          attachmentDraft: stringField(agent?.attachmentDraft, "agent.attachmentDraft") ?? "",
        },
      });
      const location = new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString();
      return jsonResponse({ workspace: { id, phase: "starting", url: location } }, { status: 202, headers: { location } });
    }

    const { id } = await createWorkspaceFromCommand({ source: { type: "empty" } });
    const location = new URL(`/workspaces/${encodeURIComponent(id)}`, url).toString();
    if (wantsTurboStream(request)) return turboStreamResponse(workspacePaneCollectionsTurboStream(await workspacePaneCollections("")), { headers: { location } });
    return Response.redirect(location, 303);
  }

  async function createAgentWorkspaceFromForm(request: Request, options: { project?: ProjectSummary } = {}): Promise<Response> {
    const form = await request.formData();
    const attachmentDraft = String(form.get("attachmentDraft") ?? "");
    if (!attachmentDraft) throw invalidArguments("attachmentDraft is required");
    let launch = launchComposerSubmissions.get(attachmentDraft);
    if (!launch) {
      launch = (async () => {
        const model = String(form.get("model") ?? "");
        const thinkingLevel = String(form.get("level") ?? "");
        await rememberNewWorkspaceAgentSettings(model, thinkingLevel);
        return await createWorkspaceFromCommand({
          source: options.project ? { type: "project", project: options.project } : { type: "empty" },
          agent: {
            initialPrompt: String(form.get("text") ?? ""),
            model,
            thinkingLevel,
            attachmentDraft,
          },
        });
      })();
      launchComposerSubmissions.set(attachmentDraft, launch);
    }
    const { id, isFirstWorkspace } = await launch;
    return turboStreamResponse(`${workspacePaneCollectionsTurboStream(await workspacePaneCollections(""))}${turboUpdateStream(launchComposerFrameId, "")}${isFirstWorkspace ? selectWorkspaceTurboStream(id) : ""}`);
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

  async function broadcastWorkspaceReady(id: string): Promise<void> {
    try {
      // No "visible" class in broadcasts: each client shows the resident
      // itself iff it is currently looking at this workspace.
      broadcastShell(turboReplaceStream(workspaceBootId(id), await workspaceDetailResidentHtml(id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`could not render workspace detail for ${id}: ${message}`);
    }
  }

  function deletionPresentation(entry: WorkspaceEntry, state: WorkspaceDeletionState): string {
    const details = state.status === "blocked" ? deletion.evidence(entry.id) : undefined;
    const evidence = details === undefined ? undefined : deletionReview.renderEvidence(entry.id, details);
    return renderWorkspaceDeletionPresentation(entry.id, state, evidence);
  }

  function deletionPresentationStream(entry: WorkspaceEntry, deletion: WorkspaceDeletionState): string {
    return `${turboReplaceStream(workspacePresentationDomId(entry.id), deletionPresentation(entry, deletion))}${workspacePreparationInvalidatedTurboStream(entry.id)}`;
  }

  function broadcastDeletionPresentation(id: string): void {
    const entry = requireWorkspace(id);
    if (!entry.deletion) throw new Error(`workspace ${id} has no deletion state`);
    const resident = `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(id)}">${deletionPresentation(entry, entry.deletion)}</div>`;
    broadcastShell(`${deletionPresentationStream(entry, entry.deletion)}${turboReplaceStream(workspaceBootId(id), resident)}`);
  }

  function currentDeletionStream(id: string): string {
    const entry = registry.get(id);
    return entry?.deletion ? deletionPresentationStream(entry, entry.deletion) : removeWorkspaceResidentTurboStream(id);
  }

  async function broadcastBlockedDeletion(id: string, state: WorkspaceDeletionState): Promise<void> {
    const pane = workspacePaneCollectionsTurboStream(await workspacePaneCollections(""));
    const entry = requireWorkspace(id);
    const resident = `<div class="workspace-detail-resident" data-workspace-residency-target="resident" data-workspace-id="${escapeHtml(id)}">${deletionPresentation(entry, state)}</div>`;
    broadcastShell(`${pane}${deletionPresentationStream(entry, state)}${turboReplaceStream(workspaceBootId(id), resident)}`);
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
    const pending = provisioningContinuations.get(id);
    if (entry.phase !== "starting" || !pending) throw new AtelierCoreError("workspace_not_ready", `workspace ${id} is not waiting for provisioning confirmation`);
    provisioningContinuations.delete(id);
    provisioning.apply({ workspaceId: id, id: pending.stepId, status: "failed", detail: "Continuing despite this failure", awaitingContinue: false });
    pending.resolve();
    if (requestAcceptsJson(request)) return jsonResponse({ continued: true, stepId: pending.stepId });
    return turboStreamResponse(turboReplaceStream(workspaceBootId(id), workspaceBootResidentHtml(entry)));
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
    return turboStreamResponse(currentDeletionStream(id));
  }

  async function cancelWorkspaceDeletionEndpoint(id: string, request: Request): Promise<Response> {
    if (!deletion.cancel(id)) return turboStreamResponse("", { status: 409 });
    const stream = `${turboReplaceStream(workspacePresentationDomId(id), renderWorkspacePresentation(await fixedWorkspacePresentation(id)))}${workspacePreparationInvalidatedTurboStream(id)}`;
    broadcastShell(stream);
    if (requestAcceptsJson(request)) return jsonResponse({ cancelled: true });
    return turboStreamResponse(stream);
  }

  async function confirmWorkspaceDeletionEndpoint(id: string, request: Request): Promise<Response> {
    const fingerprint = String((await request.formData()).get("fingerprint") ?? "");
    const result = await deletion.request(id, { fingerprint });
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse(currentDeletionStream(id));
  }

  async function retryWorkspaceDeletionEndpoint(id: string, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.deletion?.status !== "failed") return turboStreamResponse("", { status: 409 });
    const result = await deletion.request(id);
    if (requestAcceptsJson(request)) return jsonResponse(result);
    return turboStreamResponse(currentDeletionStream(id));
  }

  async function updateWorkspaceParkedState(id: string, parked: boolean): Promise<string> {
    const entry = requireWorkspace(id);
    if (entry.phase !== "ready") throw new AtelierCoreError("workspace_not_ready", `workspace ${id} is not ready`);
    if (entry.parked !== parked) {
      await persistWorkspaceParked(id, parked);
      suppressParkedStateCallbacks = true;
      registry.setParked(id, parked);
      suppressParkedStateCallbacks = false;
    }
    const parkedResident = parked ? removeWorkspaceResidentTurboStream(id) : "";
    const stateStream = `${workspacePaneCollectionsTurboStream(await workspacePaneCollections(""))}${parkedResident}`;
    broadcastShell(stateStream);
    return stateStream;
  }

  deps.events?.on("workspace_park_requested", async ({ workspaceId }) => {
    await updateWorkspaceParkedState(workspaceId, true);
  });

  async function parkWorkspaceEndpoint(id: string, parked: boolean, request: Request): Promise<Response> {
    const entry = requireWorkspace(id);
    if (entry.phase !== "ready") return requestAcceptsJson(request)
      ? jsonResponse({ error: { code: "workspace_not_ready", message: `workspace ${id} is not ready` } }, { status: 409 })
      : wantsTurboStream(request) ? turboStreamResponse("", { status: 409 }) : response("Workspace is not ready", { status: 409 });
    const stateStream = await updateWorkspaceParkedState(id, parked);
    if (requestAcceptsJson(request)) return jsonResponse({ workspace: { id, parked } });
    if (wantsTurboStream(request)) return turboStreamResponse(stateStream);
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
    return requestAcceptsJson(request) ? await workspaceJson(id) : turboStreamResponse(workspacePaneCollectionsTurboStream(await workspacePaneCollections(id)));
  }

  function workspaceModuleCommands(): WorkspaceModuleCommandHandler[] {
    return workspaceModules.flatMap((module) => module.commands ?? []);
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

  async function currentWorkPanePresentations(workspaceId: string): Promise<WorkPaneContribution[]> {
    const attachments = await attachWorkspaceModules(workspaceId);
    const currentWorkViews = attachments.flatMap((attachment) => attachment.workViews ?? []);
    return workViewPresentations(workspaceId, currentWorkViews, await presentationStore.listWorkViews(workspaceId));
  }

  async function openWorkspaceModuleWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, request: Request): Promise<Response> {
    return await serializePresentationMutation(workspaceId, async () => {
      const attachments = await attachWorkspaceModules(workspaceId);
      const currentWorkViews = attachments.flatMap((attachment) => attachment.workViews ?? []);
      const contribution = currentWorkViews.find((view) => workViewKey(view.reference) === workViewKey(reference));
      if (!contribution) throw new AtelierCoreError("work_view_not_found", `Work view is not available: ${workViewKey(reference)}`);
      const { opened } = await presentationStore.openWorkView(workspaceId, contribution.reference);
      const key = workViewKey(contribution.reference);
      const structural = opened ? openWorkViewTurboStream(workspaceId, await currentWorkPanePresentations(workspaceId), key) : "";
      return turboStreamResponse(deliverShellMutation(request, structural, presentWorkViewTurboStream(workspaceId, key)));
    });
  }

  async function workspaceCommandEndpoint(workspaceId: string, commandId: string, request: Request): Promise<Response> {
    const result = await executeWorkspaceCommand(workspaceId, commandId, request);
    let createdWorkView: WorkspaceWorkViewReference | undefined;
    let openedWorkView = false;
    if (result.createdWorkView) {
      const metadata = await attachWorkspaceModules(workspaceId);
      const contribution = metadata.flatMap((attachment) => attachment.workViews ?? []).find((view) => workViewKey(view.reference) === workViewKey(result.createdWorkView!));
      if (!contribution) throw new AtelierCoreError("work_view_not_found", `Command ${commandId} created an unavailable Work view`);
      createdWorkView = contribution.reference;
      ({ opened: openedWorkView } = await presentationStore.openWorkView(workspaceId, createdWorkView));
    }
    const presentation = createdWorkView || result.createdAgentConversationId ? await fixedWorkspacePresentation(workspaceId) : undefined;
    const structural = [
      result.createdAgentConversationId && presentation ? agentTabsTurboStream(presentation, { addedConversationId: result.createdAgentConversationId }) : "",
      createdWorkView && presentation ? workViewsTurboStream(workspaceId, presentation.workViews, { openedKey: openedWorkView ? workViewKey(createdWorkView) : undefined }) : "",
    ].join("");
    const origin = `${result.createdAgentConversationId ? selectAgentTurboStream(workspaceId, result.createdAgentConversationId) : ""}${createdWorkView ? presentWorkViewTurboStream(workspaceId, workViewKey(createdWorkView)) : ""}${result.streamHtml ?? ""}`;
    const responseStream = deliverShellMutation(request, structural, origin);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) {
      const command: WorkspaceCommandResponse = { id: commandId };
      if (createdWorkView) command.workView = createdWorkView;
      if (result.createdAgentConversationId) command.agentConversationId = result.createdAgentConversationId;
      return jsonResponse({ command, workViews: await presentationStore.listWorkViews(workspaceId) });
    }
    return turboStreamResponse(responseStream);
  }

  async function closeWorkViewEndpoint(workspaceId: string, encodedReference: string, request: Request): Promise<Response> {
    // SAFETY: This value is validated or constructed by the server boundary immediately surrounding this use.
    const reference = JSON.parse(encodedReference) as WorkspaceWorkViewReference;
    const adapter = workViewAdapterByType.get(reference.type);
    if (!adapter) throw new AtelierCoreError("work_view_reference_invalid", `unknown Work view type: ${reference.type}`);
    const parsed = adapter.parseReference(reference);
    const before = await presentationStore.listWorkViews(workspaceId);
    const closedKey = workViewKey(parsed);
    const closedIndex = before.findIndex((view) => workViewKey(view.reference) === closedKey);
    const open = closedIndex >= 0;
    if (!open) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${workViewKey(parsed)}`);
    await adapter.close?.({ workspaceId, reference: parsed });
    await presentationStore.closeWorkView(workspaceId, parsed);
    registry.clearViewAttention(workspaceId, closedKey);
    const storedWorkViews = await presentationStore.listWorkViews(workspaceId);
    const workViews = await currentWorkPanePresentations(workspaceId);
    const successor = workViews[Math.min(closedIndex, workViews.length - 1)]?.key;
    const structural = workViewsTurboStream(workspaceId, workViews, { removedKey: closedKey, successorKey: successor });
    const responseStream = deliverShellMutation(request, structural);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) return jsonResponse({ closed: parsed, workViews: storedWorkViews });
    return turboStreamResponse(responseStream);
  }

  async function reorderWorkViewEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseReorderWorkViewRequest(await readJsonObject(request));
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === body.key);
    if (!stored) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${body.key}`);
    await presentationStore.reorderWorkView(workspaceId, stored.reference, body.index);
    const storedWorkViews = await presentationStore.listWorkViews(workspaceId);
    const structural = workViewsTurboStream(workspaceId, await currentWorkPanePresentations(workspaceId));
    const responseStream = deliverShellMutation(request, structural);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) return jsonResponse({ workViews: storedWorkViews });
    return turboStreamResponse(responseStream);
  }

  async function closeWorkViewJsonEndpoint(workspaceId: string, request: Request): Promise<Response> {
    const body = parseCloseWorkViewRequest(await readJsonObject(request));
    return await closeWorkViewEndpoint(workspaceId, JSON.stringify(body.reference), request);
  }

  async function presentWorkViewFromAgent(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void> {
    await serializePresentationMutation(workspaceId, async () => {
      const attachments = await attachWorkspaceModules(workspaceId);
      const contribution = attachments.flatMap((attachment) => attachment.workViews ?? []).find((view) => workViewKey(view.reference) === workViewKey(reference));
      if (!contribution) throw new AtelierCoreError("work_view_not_found", `Work view is not available: ${workViewKey(reference)}`);
      const { opened } = await presentationStore.openWorkView(workspaceId, contribution.reference);
      registry.setParked(workspaceId, false);
      const attentionSequence = await presentationStore.requestAttention(workspaceId, contribution.reference);
      const key = workViewKey(contribution.reference);
      registry.markViewAttention(workspaceId, key, attentionSequence);
      const workViews = await currentWorkPanePresentations(workspaceId);
      broadcastShell(workViewsTurboStream(workspaceId, workViews, { openedKey: opened ? key : undefined, selectKey: key, intendSelection: true }));
    });
  }

  async function workViewBodyEndpoint(workspaceId: string, key: string): Promise<Response> {
    requireWorkspace(workspaceId);
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === key);
    if (!stored) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${key}`);
    const adapter = workViewAdapterByType.get(stored.reference.type)!;
    const bodyHtml = await adapter.render({ workspaceId, reference: stored.reference });
    return response(renderWorkViewBodyFrame(workspaceId, key, bodyHtml), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  async function requestWorkViewAttentionEndpoint(workspaceId: string, key: string, request: Request): Promise<Response> {
    const stored = (await presentationStore.listWorkViews(workspaceId)).find((view) => workViewKey(view.reference) === key);
    if (!stored) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${key}`);
    registry.setParked(workspaceId, false);
    const token = await presentationStore.requestAttention(workspaceId, stored.reference);
    registry.markViewAttention(workspaceId, key, token);
    const presentationStream = workViewsTurboStream(workspaceId, await currentWorkPanePresentations(workspaceId), { selectKey: key, intendSelection: true });
    const responseStream = deliverShellMutation(request, presentationStream);
    return requestAcceptsJson(request) && !wantsTurboStream(request) ? jsonResponse({ attention: stored.reference }) : turboStreamResponse(responseStream);
  }

  async function closeAgentConversationEndpoint(workspaceId: string, conversationId: string, request: Request): Promise<Response> {
    requireWorkspace(workspaceId);
    const before = await agentTabs.list({ workspaceId });
    const closedIndex = before.findIndex((agent) => agent.id === conversationId);
    if (closedIndex < 0) throw new AtelierCoreError("agent_conversation_not_found", `Agent conversation not found: ${conversationId}`);
    await agentTabs.close({ workspaceId, conversationId });
    registry.clearViewAttention(workspaceId, `agent:${conversationId}`);
    const presentation = await fixedWorkspacePresentation(workspaceId);
    const successorConversationId = presentation.agentConversations[Math.min(closedIndex, presentation.agentConversations.length - 1)]!.id;
    const structural = agentTabsTurboStream(presentation, { removedConversationId: conversationId, successorConversationId });
    const responseStream = deliverShellMutation(request, structural);
    if (requestAcceptsJson(request) && !wantsTurboStream(request)) return jsonResponse({ archivedConversationId: conversationId, agentConversations: presentation.agentConversations.map(({ id, title }) => ({ id, title })) });
    return turboStreamResponse(responseStream);
  }

  async function agentBodyEndpoint(workspaceId: string, conversationId: string): Promise<Response> {
    requireWorkspace(workspaceId);
    const bodyHtml = await agentTabs.render({ workspaceId, conversationId });
    return response(renderAgentBodyFrame(workspaceId, conversationId, bodyHtml), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  async function acknowledgeWorkspaceAttentionEndpoint(workspaceId: string, request: Request): Promise<Response> {
    requireWorkspace(workspaceId);
    const capturedTokens = attentionTokens(request);
    const workViewTokens = Object.entries(capturedTokens).filter(([viewKey]) => viewKey !== "workspace" && !viewKey.startsWith("agent:"));
    const acceptedTokens = { ...capturedTokens };
    let workAttentionChanged = false;

    if (workViewTokens.length > 0) {
      const workViewsByKey = new Map((await presentationStore.listWorkViews(workspaceId)).map((view) => [workViewKey(view.reference), view]));
      for (const [viewKey, token] of workViewTokens) {
        const workView = workViewsByKey.get(viewKey);
        if (!workView) continue;
        if (!await presentationStore.acknowledgeAttention(workspaceId, workView.reference, token)) delete acceptedTokens[viewKey];
        else workAttentionChanged = true;
      }
    }

    registry.acknowledgeAttention(workspaceId, acceptedTokens);
    if (workAttentionChanged) broadcastShell(workViewsTurboStream(workspaceId, await currentWorkPanePresentations(workspaceId)));
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
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
    const status = error instanceof AtelierCoreError && ["invalid_arguments", "invalid_git_url"].includes(error.code) ? 400
      : error instanceof AtelierCoreError && ["workspace_not_found", "project_not_found", "repo_not_found", "terminal_not_found", "agent_conversation_not_found"].includes(error.code) ? 404
        : error instanceof AtelierCoreError && ["last_agent_conversation", "workspace_not_ready"].includes(error.code) ? 409
          : 500;
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
    if (url.pathname === "/openapi.json" && request.method === "GET") return jsonResponse(atelierOpenApi(workspaceModuleCommands()));
    if (url.pathname === "/launch-composer" && request.method === "GET") return response(await renderProjectlessLaunchComposerFrame());
    if (url.pathname === "/launch-composer/settings" && request.method === "GET") return response(await launchComposerSettingsFrame(url.searchParams.get("model") ?? undefined));
    const projectSettingsMatch = url.pathname.match(/^\/projects\/([^/]+)\/settings$/);
    if (projectSettingsMatch && request.method === "GET") return await surfacePage({ kind: "project-settings", projectId: decodeURIComponent(projectSettingsMatch[1]!), section: url.searchParams.get("section") ?? undefined });
    const projectWorkspaceMatch = url.pathname.match(/^\/projects\/([^/]+)\/workspaces\/new$/);
    if (projectWorkspaceMatch && request.method === "GET") return await surfacePage({ kind: "new-workspace", project: await projectRoutes.byReference(decodeURIComponent(projectWorkspaceMatch[1]!)) });
    if (url.pathname === "/workspaces/new" && request.method === "GET") return await surfacePage({ kind: "new-workspace" });
    if (url.pathname === "/projects/new" && request.method === "GET") return await surfacePage({ kind: "new-project" });
    if (url.pathname === "/settings" && request.method === "GET" && !wantsTurboStream(request)) return await surfacePage({ kind: "settings", section: url.searchParams.get("section") ?? undefined });
    if (url.pathname === "/settings/development" && request.method === "GET" && !wantsTurboStream(request)) return await surfacePage({ kind: "settings", section: undefined, development: true });
    if (url.pathname === "/workspaces" && request.method === "GET") return workspaceListEndpoint(request, url);
    if (url.pathname === "/workspaces" && request.method === "POST") return await createWorkspaceEndpoint(url, request);
    if (url.pathname === "/workspaces/open-oldest-unread" && request.method === "POST") return openOldestAttentionWorkspaceEndpoint();

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

    const settingsResponse = await handleSettingsRequest(request, url, { forceDeleteAllWorkspaces: forceDeleteAllWorkspacesFromSettings });
    if (settingsResponse) return settingsResponse;

    const onboardingResponse = await handleOnboardingRequest(request, url);
    if (onboardingResponse) return onboardingResponse;

    for (const moduleRoute of workspaceModuleRoutes()) {
      const moduleResponse = await moduleRoute.handle(request, url, {
        events: deps.events,
        openWorkView: async (workspaceId, reference) => await openWorkspaceModuleWorkView(workspaceId, reference, request),
      });
      if (moduleResponse) return moduleResponse;
    }

    let params: string[] | undefined;


    if (url.pathname === "/agent-workspaces" && request.method === "POST") return await createEmptyAgentWorkspaceEndpoint(request);

    if ((params = match(/^\/workspaces\/([^/]+)\/sidebar-title$/)) && request.method === "POST") return await updateWorkspaceSidebarTitle(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/commands\/([^/]+)$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const commandId = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await workspaceCommandEndpoint(workspaceId, commandId, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/attention\/acknowledge$/)) && request.method === "POST") return acknowledgeWorkspaceAttentionEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/body$/)) && request.method === "GET") return await agentBodyEndpoint(params[0], params[1]);
    if ((params = match(/^\/workspaces\/([^/]+)\/agents\/([^/]+)\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      const conversationId = routeParam(params, 1);
      return await serializePresentationMutation(workspaceId, async () => await closeAgentConversationEndpoint(workspaceId, conversationId, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/close$/)) && request.method === "POST") {
      const workspaceId = routeParam(params, 0);
      return await serializePresentationMutation(workspaceId, async () => await closeWorkViewJsonEndpoint(workspaceId, request));
    }
    if ((params = match(/^\/workspaces\/([^/]+)\/work-views\/([^/]+)\/body$/)) && request.method === "GET") return await workViewBodyEndpoint(params[0], params[1]);
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
    if ((params = match(/^\/workspaces\/([^/]+)\/provisioning\/continue$/)) && request.method === "POST") return continueWorkspaceProvisioningEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete\/cancel$/)) && request.method === "POST") return await cancelWorkspaceDeletionEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete\/confirm$/)) && request.method === "POST") return await confirmWorkspaceDeletionEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete\/retry$/)) && request.method === "POST") return await retryWorkspaceDeletionEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)\/delete$/)) && request.method === "POST") return await deleteWorkspaceEndpoint(params[0], request);
    if ((params = match(/^\/workspaces\/([^/]+)$/)) && request.method === "GET") return await workspacePage(params[0], request);

    return response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return {
    shellSnapshot: async () => workspacePaneCollectionsTurboStream(await workspacePaneCollections("")),
    deleteCurrentWorkspaceFromAgent,
    resumeWorkspaceDeletions: deletion.resume,
    presentWorkViewFromAgent,
    globalSidebarContributions,
    async fetch(request) {
      try {
        return await route(request);
      } catch (thrown) {
        const error = thrown instanceof Error ? thrown : new Error(String(thrown));
        return requestAcceptsJson(request) ? problemJsonResponse(error) : errorPage(error);
      }
    },
  };
}
