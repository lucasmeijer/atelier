/// <reference lib="dom" />

import type { WorkspaceClientApplication, WorkspaceClientControllerConstructor, WorkspaceClientSurfaceVisibilityContext } from "@atelier/shared";

type PresentationPane = HTMLElement & { dataset: DOMStringMap & { workspaceLiveNode?: string; workspacePaneRole?: string; workspacePaneId?: string } };
type PhoneDestination = "workspace" | `agent:${string}` | `work:${string}`;

interface PersonalNavigationState {
  activeAgentId?: string;
  activeWorkViewKey?: string;
  workspacePaneVisible: boolean;
  workPaneVisible: boolean;
  phoneDestination: PhoneDestination;
  drawers: string[];
}

interface PresentationLifecycle {
  becomeVisible(context: WorkspaceClientSurfaceVisibilityContext): void;
  noLongerVisible(context: WorkspaceClientSurfaceVisibilityContext): void;
}

interface PresentationApplication extends WorkspaceClientApplication {
  start(): Promise<void>;
  stop(): void;
}

interface StreamElement extends HTMLElement {
  readonly targetElements: HTMLElement[];
  readonly templateContent: DocumentFragment;
}

interface TurboLike {
  StreamActions: Record<string, (this: StreamElement) => void | Promise<void>>;
}

const visiblePresentationPanes = new WeakSet<HTMLElement>();

interface StoredPersonalNavigation {
  activeAgentId?: unknown;
  activeWorkViewKey?: unknown;
  workspacePaneVisible?: unknown;
  workPaneVisible?: unknown;
  phoneDestination?: unknown;
  drawers?: unknown;
}

function storedNavigation(storage: Storage, key: string): StoredPersonalNavigation | undefined {
  const value = storage.getItem(key);
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid personal navigation state at ${key}`);
  // SAFETY: every field remains unknown and is parsed by restoreState before use.
  return parsed as StoredPersonalNavigation;
}

function moveNodeBefore(parent: ParentNode, node: Node, reference: Node): void {
  const statePreservingParent = parent as ParentNode & { moveBefore?(node: Node, child: Node | null): void };
  if (statePreservingParent.moveBefore) statePreservingParent.moveBefore(node, reference);
  else (parent as Node).insertBefore(node, reference);
}

export function createWorkspacePresentationController(
  Controller: WorkspaceClientControllerConstructor,
  application: PresentationApplication,
  lifecycle: PresentationLifecycle,
) {
  return class WorkspacePresentationController extends Controller {
    static values = { workspaceId: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    private state!: PersonalNavigationState;
    private media?: MediaQueryList;
    private resize?: { startX: number; startWidth: number; pointerId: number; handle: HTMLElement };
    private scrollTimer?: ReturnType<typeof setTimeout>;
    private moreOpen = false;
    private draggedWorkKey?: string;

    connect(): void {
      this.state = this.restoreState();
      this.media = window.matchMedia("(max-width: 700px)");
      this.media.addEventListener("change", this.viewportChanged);
      window.addEventListener("resize", this.viewportChanged);
      this.element.addEventListener("keydown", this.keydown);
      this.element.addEventListener("atelier:workspace-residency-visible", this.residencyVisible);
      this.element.addEventListener("atelier:workspace-residency-hidden", this.residencyHidden);
      this.workspaceScroll?.addEventListener("scroll", this.workspaceScrolled, { passive: true });
      this.restorePreferences();
      this.normalizeState();
      this.applyState({ emit: true });
    }

    disconnect(): void {
      this.media?.removeEventListener("change", this.viewportChanged);
      window.removeEventListener("resize", this.viewportChanged);
      this.element.removeEventListener("keydown", this.keydown);
      this.element.removeEventListener("atelier:workspace-residency-visible", this.residencyVisible);
      this.element.removeEventListener("atelier:workspace-residency-hidden", this.residencyHidden);
      this.workspaceScroll?.removeEventListener("scroll", this.workspaceScrolled);
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.visiblePanes().forEach((pane) => this.emitHidden(pane));
    }

    selectWorkspace(event: Event): void {
      const workspaceId = (event.currentTarget as HTMLElement).dataset.workspaceEntryId;
      if (!workspaceId) return;
      sessionStorage.setItem("atelier:active-workspace", workspaceId);
      this.element.dispatchEvent(new CustomEvent("atelier:workspace-selected", { bubbles: true, detail: { workspaceId } }));
      if (this.isPhone) {
        this.state.phoneDestination = `agent:${this.state.activeAgentId!}`;
        this.persistAndApply();
      }
    }

    selectAgent(event: Event): void {
      const id = (event.currentTarget as HTMLElement).dataset.agentTabId;
      if (!id) return;
      this.state.activeAgentId = id;
      this.state.phoneDestination = `agent:${id}`;
      this.persistAndApply({ focus: true });
    }

    selectWorkView(event: Event): void {
      const button = event.currentTarget as HTMLElement;
      const key = button.dataset.workViewKey;
      if (!key) return;
      this.activateWorkView(key, button.dataset.workViewKind === "contextual");
    }

    selectMoreWorkView(event: Event): void {
      const key = (event.currentTarget as HTMLElement).dataset.moreWorkKey;
      if (!key) return;
      this.moreOpen = false;
      this.activateWorkView(key, true);
    }

    toggleMore(): void {
      this.moreOpen = !this.moreOpen;
      this.applyState({ emit: false, focus: this.moreOpen });
    }

    selectMobileDestination(event: Event): void {
      const destination = (event.currentTarget as HTMLElement).dataset.mobileDestination as PhoneDestination | undefined;
      if (!destination) return;
      this.state.phoneDestination = destination;
      if (destination.startsWith("work:")) {
        this.state.activeWorkViewKey = destination.slice(5);
        this.state.workPaneVisible = true;
      }
      if (destination.startsWith("agent:")) this.state.activeAgentId = destination.slice(6);
      this.moreOpen = false;
      this.persistAndApply({ focus: true });
    }

    confirmClose(event: SubmitEvent): void {
      const label = (event.currentTarget as HTMLElement).dataset.closeLabel ?? "this destination";
      if (!window.confirm(`Close ${label}? Its live state will be destroyed.`)) event.preventDefault();
    }

    toggleWorkspacePane(): void {
      this.state.workspacePaneVisible = !this.state.workspacePaneVisible;
      this.persistAndApply({ focus: true });
    }

    closeWorkspacePane(): void {
      if (!this.state.workspacePaneVisible) return;
      this.state.workspacePaneVisible = false;
      this.persistAndApply({ focus: true });
    }

    toggleWorkPane(): void {
      this.state.workPaneVisible = !this.state.workPaneVisible && Boolean(this.state.activeWorkViewKey);
      this.persistAndApply({ focus: true });
    }

    toggleProject(event: Event): void {
      const button = event.currentTarget as HTMLElement;
      const id = button.dataset.projectId;
      if (!id) return;
      const project = this.element.querySelector<HTMLElement>(`.fixed-shell-project[data-project-id="${CSS.escape(id)}"]`)!;
      const collapsed = !project.classList.contains("is-collapsed");
      project.classList.toggle("is-collapsed", collapsed);
      button.setAttribute("aria-expanded", String(!collapsed));
      const disclosures = this.projectDisclosures();
      disclosures[id] = !collapsed;
      localStorage.setItem("atelier:workspace-project-disclosures", JSON.stringify(disclosures));
    }

    toggleDrawer(event: Event): void {
      const id = (event.currentTarget as HTMLElement).dataset.workspaceDrawerId;
      if (!id) return;
      this.state.drawers = this.state.drawers.includes(id) ? this.state.drawers.filter((candidate) => candidate !== id) : [...this.state.drawers, id];
      this.persistAndApply();
    }

    beginWorkResize(event: PointerEvent): void {
      const handle = event.currentTarget as HTMLElement;
      this.resize = { startX: event.clientX, startWidth: this.workPane.getBoundingClientRect().width, pointerId: event.pointerId, handle };
      handle.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", this.resizeWork);
      window.addEventListener("pointerup", this.finishWorkResize, { once: true });
    }

    beginWorkReorder(event: DragEvent): void {
      this.draggedWorkKey = (event.currentTarget as HTMLElement).dataset.workTabKey;
      if (this.draggedWorkKey) event.dataTransfer?.setData("text/plain", this.draggedWorkKey);
    }

    allowWorkReorder(event: DragEvent): void {
      if (this.draggedWorkKey) event.preventDefault();
    }

    async finishWorkReorder(event: DragEvent): Promise<void> {
      if (!this.draggedWorkKey) return;
      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      const tabs = [...target.parentElement!.querySelectorAll<HTMLElement>("[data-work-tab-key]")];
      const index = tabs.indexOf(target);
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/work-views/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/vnd.turbo-stream.html" },
        body: JSON.stringify({ key: this.draggedWorkKey, index }),
      });
      this.draggedWorkKey = undefined;
      const html = await response.text();
      if (!response.ok) throw new Error(html || `HTTP ${response.status}`);
      window.Turbo?.renderStreamMessage(html);
    }

    resizeWorkWithKeyboard(event: KeyboardEvent): void {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      this.setWorkWidth(this.workPane.getBoundingClientRect().width + direction * (event.shiftKey ? 80 : 24), true);
    }

    private activateWorkView(key: string, contextual: boolean): void {
      this.state.activeWorkViewKey = key;
      this.state.workPaneVisible = true;
      if (this.isPhone) this.state.phoneDestination = `work:${key}`;
      if (contextual) this.element.dataset.activeContextualWork = key;
      this.persistAndApply({ focus: true });
    }

    private get isPhone(): boolean { return this.media?.matches ?? window.matchMedia("(max-width: 700px)").matches; }
    private get workPane(): HTMLElement { return this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='workPane']")!; }
    private get workspaceScroll(): HTMLElement | null { return this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='workspaceScroll']"); }
    private get storageKey(): string { return `atelier:workspace-navigation:${this.workspaceIdValue}`; }

    private restoreState(): PersonalNavigationState {
      const stored = storedNavigation(sessionStorage, this.storageKey);
      if (stored?.activeAgentId !== undefined && typeof stored.activeAgentId !== "string") throw new Error("invalid personal navigation activeAgentId");
      if (stored?.activeWorkViewKey !== undefined && typeof stored.activeWorkViewKey !== "string") throw new Error("invalid personal navigation activeWorkViewKey");
      if (stored?.workspacePaneVisible !== undefined && typeof stored.workspacePaneVisible !== "boolean") throw new Error("invalid personal navigation workspacePaneVisible");
      if (stored?.workPaneVisible !== undefined && typeof stored.workPaneVisible !== "boolean") throw new Error("invalid personal navigation workPaneVisible");
      if (stored?.phoneDestination !== undefined && typeof stored.phoneDestination !== "string") throw new Error("invalid personal navigation phoneDestination");
      if (stored?.drawers !== undefined && (!Array.isArray(stored.drawers) || stored.drawers.some((item) => typeof item !== "string"))) throw new Error("invalid personal navigation drawers");
      return {
        activeAgentId: stored?.activeAgentId,
        activeWorkViewKey: stored?.activeWorkViewKey,
        workspacePaneVisible: stored?.workspacePaneVisible ?? true,
        workPaneVisible: stored?.workPaneVisible ?? false,
        phoneDestination: (stored?.phoneDestination ?? "workspace") as PhoneDestination,
        drawers: stored?.drawers ?? [],
      };
    }

    private normalizeState(): void {
      const agents = [...this.element.querySelectorAll<HTMLElement>("[data-agent-tab-id], [data-workspace-pane-role='agent']")].map((item) => item.dataset.agentTabId ?? item.dataset.workspacePaneId!).filter(Boolean);
      const workViews = [...this.element.querySelectorAll<HTMLElement>("[data-work-view-key]")].map((item) => item.dataset.workViewKey!);
      if (!this.state.activeAgentId || !agents.includes(this.state.activeAgentId)) this.state.activeAgentId = agents[0];
      if (!this.state.activeWorkViewKey || !workViews.includes(this.state.activeWorkViewKey)) this.state.activeWorkViewKey = workViews[0];
      if (!this.state.activeWorkViewKey) this.state.workPaneVisible = false;
      if (this.state.phoneDestination.startsWith("work:") && !workViews.includes(this.state.phoneDestination.slice(5))) this.state.phoneDestination = `agent:${this.state.activeAgentId!}`;
      if (this.state.phoneDestination.startsWith("agent:") && !agents.includes(this.state.phoneDestination.slice(6))) this.state.phoneDestination = `agent:${this.state.activeAgentId!}`;
      this.persist();
    }

    private persist(): void { sessionStorage.setItem(this.storageKey, JSON.stringify(this.state)); }
    private persistAndApply(options: { focus?: boolean } = {}): void { this.persist(); this.applyState({ emit: true, focus: options.focus }); }

    private applyState(options: { emit: boolean; focus?: boolean }): void {
      const before = [...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")].filter((pane) => visiblePresentationPanes.has(pane));
      this.element.classList.toggle("is-workspace-pane-open", this.state.workspacePaneVisible);
      this.element.classList.toggle("is-work-pane-open", this.state.workPaneVisible);
      this.element.dataset.phoneDestination = this.state.phoneDestination;
      this.element.dataset.navigationReady = "true";

      this.element.querySelectorAll<HTMLElement>("[data-agent-tab-id]").forEach((tab) => {
        const active = tab.dataset.agentTabId === this.state.activeAgentId;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role='agent']").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.workspacePaneId === this.state.activeAgentId));

      this.element.querySelectorAll<HTMLElement>("[data-work-view-key]").forEach((tab) => {
        const active = tab.dataset.workViewKey === this.state.activeWorkViewKey;
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role='work']").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.workspacePaneId === this.state.activeWorkViewKey));
      this.element.querySelectorAll<HTMLElement>("[data-mobile-destination]").forEach((destination) => {
        const selected = destination.dataset.mobileDestination === this.state.phoneDestination;
        destination.classList.toggle("is-active", selected);
        destination.setAttribute("aria-current", selected ? "page" : "false");
      });
      const secondarySelected = this.state.phoneDestination.startsWith("work:") && !this.element.querySelector(`[data-mobile-destination="${CSS.escape(this.state.phoneDestination)}"]`);
      const moreButton = this.element.querySelector<HTMLElement>("[data-mobile-more]");
      moreButton?.classList.toggle("is-active", this.moreOpen || secondarySelected);
      moreButton?.setAttribute("aria-expanded", String(this.moreOpen));
      const moreMenu = this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='moreMenu']");
      if (moreMenu) moreMenu.hidden = !this.moreOpen;
      const moreScrim = this.element.querySelector<HTMLElement>(".fixed-shell-more-scrim");
      if (moreScrim) moreScrim.hidden = !this.moreOpen;
      this.element.querySelectorAll<HTMLElement>("[data-workspace-drawer]").forEach((drawer) => drawer.classList.toggle("is-open", this.state.drawers.includes(drawer.dataset.workspaceDrawer!)));

      const after = this.visiblePanes();
      if (options.emit) this.emitVisibilityChanges(before, after);
      if (options.focus) this.focusActiveSurface();
    }

    private visiblePanes(): PresentationPane[] {
      if (!this.element.closest(".workspace-detail-resident.visible")) return [];
      const selector = this.isPhone
        ? this.state.phoneDestination.startsWith("agent:") ? `[data-workspace-pane-role='agent'].is-active` : this.state.phoneDestination.startsWith("work:") ? `[data-workspace-pane-role='work'].is-active` : ".fixed-shell-never"
        : `[data-workspace-pane-role='agent'].is-active${this.state.workPaneVisible ? ", [data-workspace-pane-role='work'].is-active" : ""}`;
      return [...this.element.querySelectorAll<PresentationPane>(selector)];
    }

    private emitVisibilityChanges(before: PresentationPane[], after: PresentationPane[]): void {
      const beforeSet = new Set(before);
      const afterSet = new Set(after);
      before.filter((pane) => !afterSet.has(pane)).forEach((pane) => this.emitHidden(pane));
      after.filter((pane) => !beforeSet.has(pane) || !visiblePresentationPanes.has(pane)).forEach((pane) => this.emitVisible(pane));
    }

    private lifecycleContext(pane: PresentationPane): WorkspaceClientSurfaceVisibilityContext {
      return { workspaceId: this.workspaceIdValue, surfaceKey: pane.dataset.workspacePaneId!, region: pane.closest("[data-workspace-role-region]")!, pane, application };
    }

    private emitVisible(pane: PresentationPane): void {
      if (visiblePresentationPanes.has(pane)) return;
      visiblePresentationPanes.add(pane);
      pane.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]').forEach((frame) => {
        const controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { becomeVisible?(): void } | null;
        controller?.becomeVisible?.();
      });
      lifecycle.becomeVisible(this.lifecycleContext(pane));
      if (pane.dataset.workspacePaneRole === "work") void fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/work-views/${encodeURIComponent(pane.dataset.workspacePaneId!)}/attention/acknowledge`, { method: "POST" });
      pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-visible", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private emitHidden(pane: PresentationPane): void {
      if (!visiblePresentationPanes.has(pane)) return;
      visiblePresentationPanes.delete(pane);
      lifecycle.noLongerVisible(this.lifecycleContext(pane));
      pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-hidden", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private focusActiveSurface(): void {
      if (this.isPhone && this.state.phoneDestination === "workspace") {
        this.element.querySelector<HTMLElement>(".fixed-shell-workspace-row")?.focus();
        return;
      }
      if (this.isPhone && this.moreOpen) {
        this.element.querySelector<HTMLElement>("[data-more-work-key], .fixed-shell-more-section button")?.focus();
        return;
      }
      this.visiblePanes().at(-1)?.focus({ preventScroll: true });
    }

    private restorePreferences(): void {
      const width = Number(localStorage.getItem("atelier:work-pane-width"));
      this.setWorkWidth(Number.isFinite(width) && width > 0 ? width : 520, false);
      const scroll = Number(localStorage.getItem("atelier:workspace-pane-scroll"));
      if (this.workspaceScroll && Number.isFinite(scroll)) this.workspaceScroll.scrollTop = scroll;
      const disclosures = this.projectDisclosures();
      this.element.querySelectorAll<HTMLElement>(".fixed-shell-project[data-project-id]").forEach((project) => {
        const id = project.dataset.projectId!;
        if (!(id in disclosures)) return;
        project.classList.toggle("is-collapsed", !disclosures[id]);
        project.querySelector<HTMLElement>(".fixed-shell-project-heading")?.setAttribute("aria-expanded", String(disclosures[id]));
      });
    }

    private projectDisclosures(): Record<string, boolean> {
      const text = localStorage.getItem("atelier:workspace-project-disclosures");
      if (!text) return {};
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((disclosed) => typeof disclosed !== "boolean")) throw new Error("invalid Workspace Project disclosure preference");
      // SAFETY: every own value was validated as boolean above.
      return parsed as Record<string, boolean>;
    }

    private setWorkWidth(width: number, persist: boolean): void {
      const workspaceWidth = this.state?.workspacePaneVisible && window.innerWidth >= 1180 ? 275 : 0;
      const agentMinimum = workspaceWidth ? 420 : 380;
      const maximum = Math.min(760, window.innerWidth - workspaceWidth - agentMinimum);
      const bounded = Math.max(360, Math.min(width, maximum));
      this.element.style.setProperty("--fixed-work-width", `${bounded}px`);
      if (persist) localStorage.setItem("atelier:work-pane-width", String(bounded));
    }

    private resizeWork = (event: PointerEvent): void => {
      if (!this.resize) return;
      this.setWorkWidth(this.resize.startWidth - (event.clientX - this.resize.startX), false);
    };

    private finishWorkResize = (): void => {
      if (!this.resize) return;
      window.removeEventListener("pointermove", this.resizeWork);
      localStorage.setItem("atelier:work-pane-width", String(this.workPane.getBoundingClientRect().width));
      this.resize = undefined;
    };

    private viewportChanged = (): void => { this.setWorkWidth(this.workPane.getBoundingClientRect().width || 520, false); this.applyState({ emit: true }); };
    private residencyVisible = (): void => this.applyState({ emit: true });
    private residencyHidden = (): void => this.emitVisibilityChanges([...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")].filter((pane) => visiblePresentationPanes.has(pane)), []);
    private workspaceScrolled = (): void => {
      if (this.scrollTimer) clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => localStorage.setItem("atelier:workspace-pane-scroll", String(this.workspaceScroll?.scrollTop ?? 0)), 80);
    };

    private keydown = (event: KeyboardEvent): void => {
      const tab = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[role='tab']") : null;
      if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const list = tab.closest("[role='tablist']");
      const tabs = list ? [...list.querySelectorAll<HTMLElement>("[role='tab']")] : [];
      if (tabs.length < 2) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex]?.click();
      tabs[nextIndex]?.focus();
    };
  };
}

export function installWorkspacePresentationTurboStream(Turbo: TurboLike, application: PresentationApplication): void {
  Turbo.StreamActions["present-work-view"] = function presentWorkView(this: StreamElement): void {
    const key = this.dataset.workViewKey;
    if (!key) throw new Error("present-work-view requires a Work view key");
    for (const target of this.targetElements) {
      target.querySelector<HTMLButtonElement>(`[data-work-view-key="${CSS.escape(key)}"]`)?.click();
      const workspaceId = target.dataset.workspaceId;
      if (workspaceId) void fetch(`/workspaces/${encodeURIComponent(workspaceId)}/work-views/${encodeURIComponent(key)}/attention/acknowledge`, { method: "POST" });
    }
  };
  Turbo.StreamActions["replace-workspace-presentation"] = async function replaceWorkspacePresentation(this: StreamElement): Promise<void> {
    for (const target of this.targetElements) {
      const replacement = this.templateContent.firstElementChild?.cloneNode(true) as HTMLElement | null;
      if (!replacement) throw new Error("Workspace presentation stream is missing its replacement");
      const live = new Map([...target.querySelectorAll<HTMLElement>("[data-workspace-live-node]")].map((node) => [node.dataset.workspaceLiveNode!, node]));
      for (const slot of replacement.querySelectorAll<HTMLElement>("[data-workspace-live-slot]")) {
        if (!live.has(slot.dataset.workspaceLiveSlot!)) throw new Error(`Workspace presentation cannot preserve missing live node ${slot.dataset.workspaceLiveSlot}`);
      }
      application.stop();
      try {
        target.before(replacement);
        for (const slot of replacement.querySelectorAll<HTMLElement>("[data-workspace-live-slot]")) {
          const node = live.get(slot.dataset.workspaceLiveSlot!)!;
          moveNodeBefore(slot.parentNode!, node, slot);
          slot.remove();
        }
        target.remove();
      } finally {
        await application.start();
      }
    }
  };
}
