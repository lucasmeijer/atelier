import { Controller } from "@hotwired/stimulus";
import { buttonHtml } from "@atelier/design-system/button";
import { escapeHtml, phoneLayoutMediaQuery } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { controllerForElement, registerWorkspaceControllers, workspaceNavigationController } from "./workspace-controller-registry.ts";
import { oldestAttentionFirst, prioritizedWorkspacePreloads, retainedWorkspaceIds, type AttentionWorkspace, type WorkspacePreloadCandidate, type WorkspaceRetentionCandidate } from "./workspace-residency-policy.ts";

const workspaceBusyViewsSchema = Type.Array(Type.String());
const workspaceAttentionTokensSchema = Type.Record(Type.String(), Type.Integer({ minimum: 1 }));

interface WorkspaceSurfacePreparationController {
  prepareIntendedSurfaces(options?: { authoritativeReload?: boolean }): Promise<void>;
  selectedAgentId(): string;
}

type WorkspacePreparationPriority = "background" | "foreground" | "obsolete";

interface WorkspacePreparationResult {
  resident: HTMLElement;
  prepared: boolean;
}

interface WorkspacePreparationOperation {
  workspaceId: string;
  priority: WorkspacePreparationPriority;
  generation: number;
  abort: AbortController;
  promise: Promise<WorkspacePreparationResult>;
}

class WorkspaceResidencyController extends Controller<HTMLElement> {
  static targets = ["resident", "empty", "loading"];
  static values = { maxResident: Number };
  declare readonly residentTargets: HTMLElement[];
  declare readonly emptyTargets: HTMLElement[];
  declare readonly loadingTargets: HTMLElement[];
  declare readonly maxResidentValue: number;
  private selectionSeq = 0;
  private foregroundInFlight = 0;
  private intendedWorkspaceId?: string;
  private readonly prepared = new Set<string>();
  private readonly requestedPreparationAt = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly operations = new Map<string, WorkspacePreparationOperation>();
  private readonly preparationOwnedResidents = new WeakSet<HTMLElement>();
  private backgroundPump?: Promise<void>;
  private backgroundWakeRequested = false;
  private backgroundPreparationWorkspaceId?: string;
  private residencyConnected = false;

  connect(): void {
    this.residencyConnected = true;
    document.addEventListener("atelier:workspace-removed", this.workspaceRemoved);
    document.addEventListener("atelier:workspace-pane-changed", this.workspacePaneChanged);
    document.addEventListener("atelier:workspace-preparation-invalidated", this.workspacePreparationInvalidated);
    document.addEventListener("atelier:workspace-preparation-requested", this.workspacePreparationRequested);
    document.addEventListener("atelier:workspace-preparation-request-acknowledged", this.workspacePreparationRequestAcknowledged);
    document.addEventListener("visibilitychange", this.documentVisibilityChanged);
    window.addEventListener("popstate", this.historyChanged);
    const workspaceId = this.workspaceIdFromLocation();
    if (workspaceId) {
      workspaceNavigationController()?.setActiveWorkspace(workspaceId);
      void this.selectWorkspace(workspaceId, location.href, "none");
    } else {
      this.showEmpty();
      this.reconcileResidents();
    }
  }

  disconnect(): void {
    this.residencyConnected = false;
    document.removeEventListener("atelier:workspace-removed", this.workspaceRemoved);
    document.removeEventListener("atelier:workspace-pane-changed", this.workspacePaneChanged);
    document.removeEventListener("atelier:workspace-preparation-invalidated", this.workspacePreparationInvalidated);
    document.removeEventListener("atelier:workspace-preparation-requested", this.workspacePreparationRequested);
    document.removeEventListener("atelier:workspace-preparation-request-acknowledged", this.workspacePreparationRequestAcknowledged);
    document.removeEventListener("visibilitychange", this.documentVisibilityChanged);
    window.removeEventListener("popstate", this.historyChanged);
    for (const operation of this.operations.values()) operation.abort.abort();
  }

  async selectWorkspace(workspaceId: string, href: string, historyMode: "push" | "none" = "push"): Promise<void> {
    const seq = ++this.selectionSeq;
    this.intendedWorkspaceId = workspaceId;
    if (this.backgroundPreparationWorkspaceId === workspaceId) {
      this.setWorkspacePreloading(workspaceId, false);
      this.backgroundPreparationWorkspaceId = undefined;
    }
    if (historyMode === "push" && `${location.pathname}${location.search}` !== new URL(href, location.href).pathname + new URL(href, location.href).search) history.pushState({}, "", href);
    workspaceNavigationController()?.setActiveWorkspace(workspaceId);

    const existing = this.resident(workspaceId);
    if (existing && this.prepared.has(workspaceId)) {
      this.showResident(existing);
      this.reconcileResidents();
      return;
    }

    this.showLoading(workspaceId);
    for (const operation of this.operations.values()) {
      if (operation.workspaceId === workspaceId) continue;
      operation.priority = "obsolete";
      operation.abort.abort();
    }

    this.foregroundInFlight += 1;
    try {
      const result = await this.prepareWorkspace(workspaceId, "foreground");
      if (seq === this.selectionSeq) this.showResident(result.resident);
    } catch (error) {
      if (seq === this.selectionSeq) this.showLoadError(workspaceId, error instanceof Error ? error.message : String(error));
    } finally {
      this.foregroundInFlight -= 1;
      this.evictIfNeeded();
      this.reconcileResidents();
      window.setTimeout(() => this.reconcileResidents(), 0);
    }
  }

  residentTargetConnected(resident: HTMLElement): void {
    const workspaceId = resident.dataset.workspaceId;
    if (!workspaceId) return;
    if (this.preparationOwnedResidents.delete(resident)) return;
    const preparationCleared = this.prepared.delete(workspaceId);
    if (!this.operations.has(workspaceId) && this.workspaceIdFromLocation() === workspaceId && this.intendedWorkspaceId === workspaceId && !resident.classList.contains("visible")) {
      void this.selectWorkspace(workspaceId, location.href, "none");
    }
    if (this.residencyConnected && preparationCleared) this.reconcileResidents();
  }

  unselectWorkspace(workspaceId: string): void {
    if (this.visibleWorkspaceId() !== workspaceId && this.intendedWorkspaceId !== workspaceId) return;
    ++this.selectionSeq;
    this.intendedWorkspaceId = undefined;
    if (this.workspaceIdFromLocation() === workspaceId) history.replaceState({}, "", "/");
    this.showEmpty();
    workspaceNavigationController()?.showWorkspacePane();
    this.reconcileResidents();
  }

  removeWorkspace(workspaceId: string): void {
    this.operations.get(workspaceId)?.abort.abort();
    this.prepared.delete(workspaceId);
    const resident = this.resident(workspaceId);
    this.unselectWorkspace(workspaceId);
    resident?.remove();
    this.reconcileResidents();
  }

  visibleWorkspaceId(): string | undefined {
    return this.residentTargets.find((resident) => resident.classList.contains("visible"))?.dataset.workspaceId;
  }

  oldestPreparedAttentionWorkspaceId(): string | undefined {
    return this.attentionWorkspaces().find(({ workspaceId }) => this.prepared.has(workspaceId))?.workspaceId;
  }

  private syncNextUnreadButton(): void {
    const button = document.querySelector<HTMLButtonElement>("#fixed_shell_atelier_next_unread");
    if (button) button.disabled = this.oldestPreparedAttentionWorkspaceId() === undefined;
  }

  private workspaceIdFromLocation(): string | undefined {
    const match = location.pathname.match(/^\/workspaces\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]!) : undefined;
  }

  private resident(workspaceId: string): HTMLElement | undefined {
    return this.residentTargets.find((candidate) => candidate.dataset.workspaceId === workspaceId);
  }

  private presentationController(resident: HTMLElement): WorkspaceSurfacePreparationController | null {
    const presentation = resident.querySelector<HTMLElement>("[data-controller~='workspace-presentation']");
    // SAFETY: The server-rendered presentation element uses the registered controller implementing this preparation seam.
    return presentation ? controllerForElement<WorkspaceSurfacePreparationController>(presentation, "workspace-presentation") : null;
  }

  private async connectedPresentationController(resident: HTMLElement): Promise<WorkspaceSurfacePreparationController | null> {
    let controller = this.presentationController(resident);
    if (controller || !resident.querySelector("[data-controller~='workspace-presentation']")) return controller;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    controller = this.presentationController(resident);
    if (!controller) throw new Error("Workspace presentation did not connect");
    return controller;
  }

  private async prepareWorkspace(workspaceId: string, priority: Exclude<WorkspacePreparationPriority, "obsolete">): Promise<WorkspacePreparationResult> {
    const resident = this.resident(workspaceId);
    if (resident && this.prepared.has(workspaceId)) return { resident, prepared: true };
    const existing = this.operations.get(workspaceId);
    if (existing) {
      if (existing.priority === "obsolete" || existing.abort.signal.aborted) {
        await existing.promise.then(() => undefined, () => undefined);
        return this.prepareWorkspace(workspaceId, priority);
      }
      if (priority === "foreground") existing.priority = "foreground";
      const result = await existing.promise;
      return priority === "foreground" && !result.prepared && this.intendedWorkspaceId === workspaceId
        ? await this.prepareWorkspace(workspaceId, priority)
        : result;
    }
    if (!this.makeCapacityFor(workspaceId, priority)) throw new Error("Workspace is waiting for residency capacity");

    // SAFETY: The promise is assigned synchronously before the operation is published in the operations map.
    const operation = {
      workspaceId,
      priority,
      generation: this.generations.get(workspaceId) ?? 0,
      abort: new AbortController(),
    } as WorkspacePreparationOperation;
    operation.promise = this.runPreparation(operation).finally(() => {
      if (this.operations.get(workspaceId) === operation) this.operations.delete(workspaceId);
    });
    this.operations.set(workspaceId, operation);
    const result = await operation.promise;
    const changedDuringPreparation = operation.generation !== (this.generations.get(workspaceId) ?? 0);
    return !result.prepared && operation.priority !== "obsolete" && changedDuringPreparation
      ? await this.prepareWorkspace(workspaceId, priority)
      : result;
  }

  private async runPreparation(operation: WorkspacePreparationOperation): Promise<WorkspacePreparationResult> {
    const resident = this.resident(operation.workspaceId) ?? await this.fetchAndConnectResident(operation);
    if (!this.preparationIsCurrent(operation)) return { resident, prepared: false };
    const controller = await this.connectedPresentationController(resident);
    if (!this.preparationIsCurrent(operation)) return { resident, prepared: false };
    if (operation.priority === "background" && controller && this.selectedAgentIsWorking(operation.workspaceId, controller.selectedAgentId())) {
      return { resident, prepared: false };
    }
    await controller?.prepareIntendedSurfaces({ authoritativeReload: operation.generation > 0 });
    const prepared = this.preparationIsCurrent(operation);
    if (prepared) this.prepared.add(operation.workspaceId);
    return { resident, prepared };
  }

  private preparationIsActive(operation: WorkspacePreparationOperation): boolean {
    return operation.priority !== "obsolete";
  }

  private preparationIsCurrent(operation: WorkspacePreparationOperation): boolean {
    return this.preparationIsActive(operation) && operation.generation === (this.generations.get(operation.workspaceId) ?? 0);
  }

  private selectedAgentIsWorking(workspaceId: string, conversationId: string): boolean {
    return this.busyViews(workspaceId).includes(`agent:${conversationId}`);
  }

  private busyViews(workspaceId: string): string[] {
    const row = document.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    return row?.dataset.workspaceBusyViews ? Value.Parse(workspaceBusyViewsSchema, JSON.parse(row.dataset.workspaceBusyViews)) : [];
  }

  private async fetchAndConnectResident(operation: WorkspacePreparationOperation): Promise<HTMLElement> {
    const { workspaceId } = operation;
    const existing = this.resident(workspaceId);
    if (existing) return existing;
    const resident = await this.fetchResident(workspaceId, operation.abort.signal);
    if (!this.preparationIsCurrent(operation)) return resident;
    const connected = this.resident(workspaceId);
    if (connected) return connected;
    this.preparationOwnedResidents.add(resident);
    this.element.appendChild(resident);
    return resident;
  }

  private async fetchResident(workspaceId: string, signal: AbortSignal): Promise<HTMLElement> {
    const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}`, location.href);
    url.searchParams.set("resident", "1");
    const timeoutController = new AbortController();
    const abortForCaller = (): void => timeoutController.abort();
    signal.addEventListener("abort", abortForCaller, { once: true });
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, 30_000);
    const html = await fetch(url, { headers: { "Accept": "text/html" }, cache: "no-store", signal: timeoutController.signal }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }).catch((error) => {
      if (timedOut && error instanceof DOMException && error.name === "AbortError") throw new Error("Timed out loading workspace");
      throw error;
    }).finally(() => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abortForCaller);
    });
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const resident = template.content.firstElementChild;
    if (!(resident instanceof HTMLElement)) throw new Error("Workspace response did not include a resident view");
    resident.classList.remove("visible");
    return resident;
  }

  private reconcileResidents(): void {
    this.evictIfNeeded();
    this.syncNextUnreadButton();
    this.backgroundWakeRequested = true;
    this.startBackgroundPump();
  }

  private startBackgroundPump(): void {
    if (!this.residencyConnected || this.backgroundPump || this.foregroundInFlight !== 0) return;
    const pump = this.drainBackgroundWakeups();
    this.backgroundPump = pump;
    void pump.finally(() => {
      if (this.backgroundPump !== pump) return;
      this.backgroundPump = undefined;
      if (this.backgroundWakeRequested) this.startBackgroundPump();
    });
  }

  private async drainBackgroundWakeups(): Promise<void> {
    while (this.residencyConnected && this.foregroundInFlight === 0 && this.backgroundWakeRequested) {
      this.backgroundWakeRequested = false;
      await this.prepareReadyWorkspaces();
    }
  }

  private async prepareReadyWorkspaces(): Promise<void> {
    const attempted = new Set<string>();
    while (this.foregroundInFlight === 0) {
      const candidate = this.preparationCandidates().find(({ workspaceId }) => workspaceId !== this.visibleWorkspaceId() && !this.prepared.has(workspaceId) && !attempted.has(workspaceId));
      if (!candidate || !this.makeCapacityFor(candidate.workspaceId, "background")) return;
      attempted.add(candidate.workspaceId);
      this.backgroundPreparationWorkspaceId = candidate.workspaceId;
      this.setWorkspacePreloading(candidate.workspaceId, true);
      try {
        const result = await this.prepareWorkspace(candidate.workspaceId, "background");
        if (!result.prepared && !result.resident.classList.contains("visible")) result.resident.remove();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) console.error(`Could not prepare Workspace ${candidate.workspaceId}`, error);
      } finally {
        this.setWorkspacePreloading(candidate.workspaceId, false);
        if (this.backgroundPreparationWorkspaceId === candidate.workspaceId) this.backgroundPreparationWorkspaceId = undefined;
      }
      this.evictIfNeeded();
    }
  }

  private setWorkspacePreloading(workspaceId: string, preloading: boolean): void {
    const entry = document.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    if (!entry) return;
    entry.toggleAttribute("data-workspace-preloading", preloading);
    const attention = entry.querySelector<HTMLElement>(":scope > .workspace-attention-status");
    if (!attention) return;
    attention.setAttribute("aria-label", preloading ? "Attention; preparing workspace" : "Attention");
    attention.toggleAttribute("title", preloading);
    if (preloading) attention.title = "Preparing workspace";
  }

  private attentionWorkspaces(): AttentionWorkspace[] {
    return oldestAttentionFirst([...document.querySelectorAll<HTMLElement>("[data-workspace-attention-at]")].map((entry) => ({
      workspaceId: entry.dataset.workspaceEntryId!,
      attentionAt: Number(entry.dataset.workspaceAttentionAt),
    })));
  }

  private preparationCandidates(): Array<{ workspaceId: string }> {
    const candidates = new Map<string, WorkspacePreloadCandidate>([...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id]")]
      .filter((entry) => !entry.closest(".fixed-shell-parked"))
      .map((entry) => [entry.dataset.workspaceEntryId!, {
        workspaceId: entry.dataset.workspaceEntryId!,
        lastActivityAt: Number(entry.dataset.workspaceLastActivityAt ?? 0),
      }]));
    for (const { workspaceId, attentionAt } of this.attentionWorkspaces()) {
      const candidate = candidates.get(workspaceId) ?? { workspaceId, lastActivityAt: this.workspaceLastActivityAt(workspaceId) };
      candidate.attentionAt = attentionAt;
      candidates.set(workspaceId, candidate);
    }
    for (const [workspaceId, requestedAt] of this.requestedPreparationAt) {
      const candidate = candidates.get(workspaceId) ?? { workspaceId, lastActivityAt: this.workspaceLastActivityAt(workspaceId) };
      candidate.requestedAt = requestedAt;
      candidates.set(workspaceId, candidate);
    }
    return prioritizedWorkspacePreloads([...candidates.values()]);
  }

  private workspaceLastActivityAt(workspaceId: string): number {
    const row = document.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    return Number(row?.dataset.workspaceLastActivityAt ?? 0);
  }

  private retentionCandidates(extraWorkspaceId?: string, protectExtra = false): WorkspaceRetentionCandidate[] {
    const attentionAt = new Map(this.attentionWorkspaces().map((workspace) => [workspace.workspaceId, workspace.attentionAt]));
    for (const [workspaceId, requestedAt] of this.requestedPreparationAt) {
      if (!attentionAt.has(workspaceId)) attentionAt.set(workspaceId, requestedAt);
    }
    const candidates = this.residentTargets.map((resident) => {
      const workspaceId = resident.dataset.workspaceId!;
      const operation = this.operations.get(workspaceId);
      return {
        workspaceId,
        visible: resident.classList.contains("visible"),
        prepared: this.prepared.has(workspaceId),
        preparing: operation ? this.preparationIsCurrent(operation) : false,
        attentionAt: attentionAt.get(workspaceId),
        lastActivatedAt: Math.max(Number(resident.dataset.lastActivatedAt ?? 0), this.workspaceLastActivityAt(workspaceId)),
        protected: operation?.priority === "foreground",
      };
    });
    if (extraWorkspaceId && !candidates.some((candidate) => candidate.workspaceId === extraWorkspaceId)) {
      candidates.push({ workspaceId: extraWorkspaceId, visible: false, prepared: false, preparing: true, attentionAt: attentionAt.get(extraWorkspaceId), lastActivatedAt: this.workspaceLastActivityAt(extraWorkspaceId), protected: protectExtra });
    }
    return candidates;
  }

  private makeCapacityFor(workspaceId: string, priority: "background" | "foreground"): boolean {
    const candidates = this.retentionCandidates(workspaceId, priority === "foreground");
    const retained = retainedWorkspaceIds(candidates, this.maxResidentValue);
    if (!retained.has(workspaceId)) return false;
    for (const resident of this.residentTargets) {
      const id = resident.dataset.workspaceId!;
      if (!retained.has(id)) this.evictResident(resident);
    }
    return true;
  }

  private evictIfNeeded(): void {
    this.syncNextUnreadButton();
    const retained = retainedWorkspaceIds(this.retentionCandidates(), this.maxResidentValue);
    for (const resident of this.residentTargets) {
      if (!retained.has(resident.dataset.workspaceId!)) this.evictResident(resident);
    }
  }

  private evictResident(resident: HTMLElement): void {
    const workspaceId = resident.dataset.workspaceId!;
    if (resident.classList.contains("visible")) throw new Error(`Cannot evict visible Workspace ${workspaceId}`);
    this.prepared.delete(workspaceId);
    resident.remove();
    this.syncNextUnreadButton();
  }

  private hideResidents(): void {
    for (const resident of this.residentTargets) {
      const wasVisible = resident.classList.contains("visible");
      resident.classList.remove("visible");
      if (wasVisible) {
        const presentation = resident.querySelector<HTMLElement>(".fixed-workspace-presentation");
        presentation?.dispatchEvent(new CustomEvent("atelier:workspace-residency-hidden"));
        const workspaceId = resident.dataset.workspaceId!;
        if (workspaceId !== this.intendedWorkspaceId) void this.capturePreparedResident(workspaceId, resident).catch((error) => console.error(`Could not retain prepared Workspace ${workspaceId}`, error));
      }
    }
  }

  private async capturePreparedResident(workspaceId: string, resident: HTMLElement): Promise<void> {
    const generation = this.generations.get(workspaceId) ?? 0;
    const controller = await this.connectedPresentationController(resident);
    if (!controller || this.selectedAgentIsWorking(workspaceId, controller.selectedAgentId())) return;
    await controller.prepareIntendedSurfaces();
    if (!resident.isConnected || this.resident(workspaceId) !== resident || generation !== (this.generations.get(workspaceId) ?? 0)) return;
    this.prepared.add(workspaceId);
    this.evictIfNeeded();
  }

  private showEmpty(): void {
    this.setSwitchingWorkspace(false);
    this.hideResidents();
    document.querySelectorAll<HTMLElement>("[data-workspace-entry-id][aria-current=\"page\"]").forEach((row) => {
      row.removeAttribute("aria-current");
    });
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    this.emptyTargets.forEach((empty) => { empty.hidden = false; });
  }

  private showLoading(workspaceId: string): void {
    this.setSwitchingWorkspace(true);
    this.hideResidents();
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    const row = document.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    const title = row?.getAttribute("title") ?? workspaceId;
    this.loadingTargets.forEach((loading) => {
      loading.hidden = false;
      const pad = loading.querySelector<HTMLElement>(".pad");
      if (pad) pad.innerHTML = `<span class="status-spinner"></span> Loading ${escapeHtml(title)}…`;
    });
  }

  private showLoadError(workspaceId: string, message: string): void {
    this.setSwitchingWorkspace(false);
    this.hideResidents();
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => {
      loading.hidden = false;
      const pad = loading.querySelector<HTMLElement>(".pad");
      if (pad) pad.innerHTML = `<p>Could not load workspace: ${escapeHtml(message)}</p>${buttonHtml({
        type: "button",
        variant: "primary",
        content: { kind: "caption", caption: "Retry" },
        attributesHtml: `data-action="click->workspace-navigation#selectWorkspace" data-workspace-entry-id="${escapeHtml(workspaceId)}"`,
      })}`;
    });
  }

  private showResident(resident: HTMLElement): void {
    this.setSwitchingWorkspace(false);
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    resident.dataset.lastActivatedAt = String(Date.now());
    for (const candidate of this.residentTargets) {
      if (candidate !== resident && candidate.classList.contains("visible")) {
        candidate.querySelector<HTMLElement>(".fixed-workspace-presentation")?.dispatchEvent(new CustomEvent("atelier:workspace-residency-hidden"));
        const hiddenWorkspaceId = candidate.dataset.workspaceId!;
        void this.capturePreparedResident(hiddenWorkspaceId, candidate).catch((error) => console.error(`Could not retain prepared Workspace ${hiddenWorkspaceId}`, error));
      }
      candidate.classList.toggle("visible", candidate === resident);
    }
    resident.querySelector<HTMLElement>(".fixed-workspace-presentation")?.dispatchEvent(new CustomEvent("atelier:workspace-residency-visible"));
    const workspaceId = resident.dataset.workspaceId!;
    workspaceNavigationController()?.setActiveWorkspace(workspaceId);
    this.acknowledgeVisibleWorkspace();
  }

  private acknowledgeVisibleWorkspace(): void {
    if (document.visibilityState !== "visible") return;
    const workspaceId = this.visibleWorkspaceId();
    if (!workspaceId || workspaceId !== this.intendedWorkspaceId) return;
    const row = document.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    let serializedTokens = row?.dataset.workspaceAttentionTokens;
    if (!serializedTokens) return;
    if (window.matchMedia(phoneLayoutMediaQuery).matches) {
      const tokens = Value.Parse(workspaceAttentionTokensSchema, JSON.parse(serializedTokens));
      const destination = document.querySelector<HTMLElement>(".workspace-detail-resident.visible .fixed-workspace-presentation")?.dataset.phoneDestination;
      const visibleWorkViewKey = destination?.startsWith("work:") ? destination.slice(5) : undefined;
      for (const key of Object.keys(tokens)) {
        if (key !== "workspace" && !key.startsWith("agent:") && key !== visibleWorkViewKey) delete tokens[key];
      }
      serializedTokens = JSON.stringify(tokens);
    }
    // The server acknowledges only these exact occurrences, so newer Attention survives a delayed request.
    void fetch(`/workspaces/${encodeURIComponent(workspaceId)}/attention/acknowledge?attentionTokens=${encodeURIComponent(serializedTokens)}`, { method: "POST" });
  }

  private setSwitchingWorkspace(switching: boolean): void {
    this.element.closest(".fixed-shell-app")?.classList.toggle("is-switching-workspace", switching);
  }

  private readonly workspaceRemoved = (event: Event): void => {
    // SAFETY: remove-workspace-resident is the sole producer and supplies this detail contract.
    const { workspaceId } = (event as CustomEvent<{ workspaceId: string }>).detail;
    this.removeWorkspace(workspaceId);
  };

  private readonly workspacePaneChanged = (): void => {
    if (this.backgroundPreparationWorkspaceId) this.setWorkspacePreloading(this.backgroundPreparationWorkspaceId, true);
    this.reconcileResidents();
    this.acknowledgeVisibleWorkspace();
  };

  private readonly documentVisibilityChanged = (): void => {
    this.acknowledgeVisibleWorkspace();
  };

  private readonly workspacePreparationInvalidated = (event: Event): void => {
    // SAFETY: invalidate-workspace-preparation is the sole producer and supplies this detail contract.
    const { workspaceId } = (event as CustomEvent<{ workspaceId: string }>).detail;
    this.prepared.delete(workspaceId);
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1);
    this.reconcileResidents();
  };

  private readonly workspacePreparationRequested = (event: Event): void => {
    // SAFETY: intend-work-view is the sole producer and supplies this detail contract.
    const { workspaceId } = (event as CustomEvent<{ workspaceId: string }>).detail;
    if (!this.requestedPreparationAt.has(workspaceId)) this.requestedPreparationAt.set(workspaceId, Date.now());
    this.reconcileResidents();
  };

  private readonly workspacePreparationRequestAcknowledged = (event: Event): void => {
    // SAFETY: Workspace presentation visibility is the sole producer and supplies this detail contract.
    const { workspaceId } = (event as CustomEvent<{ workspaceId: string }>).detail;
    this.requestedPreparationAt.delete(workspaceId);
    this.reconcileResidents();
  };

  private readonly historyChanged = (): void => {
    const workspaceId = this.workspaceIdFromLocation();
    if (workspaceId) {
      workspaceNavigationController()?.setActiveWorkspace(workspaceId);
      void this.selectWorkspace(workspaceId, location.href, "none");
    } else {
      ++this.selectionSeq;
      this.intendedWorkspaceId = undefined;
      this.showEmpty();
    }
  };
}

export function registerWorkspaceResidencyController(): void {
  registerWorkspaceControllers({
    "workspace-residency": WorkspaceResidencyController,
  });
}
