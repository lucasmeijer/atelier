/// <reference lib="dom" />

import type { WorkspaceClientApplication, WorkspaceClientControllerConstructor, WorkspaceClientSurfaceVisibilityContext } from "@atelier/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

type PresentationPane = HTMLElement & { dataset: DOMStringMap & { workspaceLiveNode?: string; workspacePaneRole?: string; workspacePaneId?: string } };
const phoneDestinationSchema = Type.Union([
  Type.Literal("workspace"),
  Type.TemplateLiteral("agent:${string}"),
  Type.TemplateLiteral("work:${string}"),
]);
type PhoneDestination = Static<typeof phoneDestinationSchema>;

const storedPersonalNavigationSchema = Type.Object({
  activeAgentId: Type.Optional(Type.String()),
  activeWorkViewKey: Type.Optional(Type.String()),
  workPaneVisible: Type.Optional(Type.Boolean()),
  phoneDestination: Type.Optional(phoneDestinationSchema),
  drawers: Type.Optional(Type.Array(Type.String())),
});
type StoredPersonalNavigation = Static<typeof storedPersonalNavigationSchema>;

interface PersonalNavigationState {
  activeAgentId?: string;
  activeWorkViewKey?: string;
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
const attentionActivatedResidents = new WeakSet<HTMLElement>();

function storedNavigation(storage: Storage, key: string): StoredPersonalNavigation | undefined {
  const value = storage.getItem(key);
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Value.Check(storedPersonalNavigationSchema, parsed)) throw new Error(`invalid personal navigation state at ${key}`);
  return parsed;
}

export function markActiveWorkspaceRow(root: ParentNode, workspaceId: string): void {
  root.querySelectorAll<HTMLElement>(".fixed-shell-workspace-row.active").forEach((row) => {
    row.classList.remove("active");
    row.removeAttribute("aria-current");
  });
  const active = root.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
  active?.classList.add("active");
  active?.setAttribute("aria-current", "page");
  active?.querySelector(".fixed-shell-attention-dot")?.remove();
}

function moveNodeBefore(parent: ParentNode, node: Node, reference: Node): void {
  // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
  const statePreservingParent = parent as ParentNode & { moveBefore?(node: Node, child: Node | null): void };
  if (statePreservingParent.moveBefore) statePreservingParent.moveBefore(node, reference);
  else {
    // SAFETY: ParentNode is implemented by Node for the server-rendered DOM parents used here.
    (parent as Node).insertBefore(node, reference);
  }
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
      this.restorePreferences();
      this.normalizeState();
      const focusAttendedWorkView = !this.applyDeepLink() && this.activateNewestAttendedWorkView();
      this.applyState({ emit: true, focus: focusAttendedWorkView });
    }

    disconnect(): void {
      this.media?.removeEventListener("change", this.viewportChanged);
      window.removeEventListener("resize", this.viewportChanged);
      this.element.removeEventListener("keydown", this.keydown);
      this.element.removeEventListener("atelier:workspace-residency-visible", this.residencyVisible);
      this.element.removeEventListener("atelier:workspace-residency-hidden", this.residencyHidden);
      this.visiblePanes().forEach((pane) => this.emitHidden(pane));
    }

    selectAgent(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const id = (event.currentTarget as HTMLElement).dataset.agentConversationId;
      if (!id) return;
      this.state.activeAgentId = id;
      this.state.phoneDestination = `agent:${id}`;
      this.persistAndApply({ focus: true });
    }

    selectWorkView(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const button = event.currentTarget as HTMLElement;
      const key = button.dataset.workViewKey;
      if (!key) return;
      this.activateWorkView(key, button.dataset.workViewKind === "contextual");
    }

    selectMoreWorkView(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
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
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
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
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const label = (event.currentTarget as HTMLElement).dataset.closeLabel ?? "this destination";
      if (!window.confirm(`Close ${label}? Its live state will be destroyed.`)) event.preventDefault();
    }

    toggleWorkPane(): void {
      this.state.workPaneVisible = !this.state.workPaneVisible && Boolean(this.state.activeWorkViewKey);
      this.persistAndApply({ focus: true });
    }

    toggleDrawer(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const id = (event.currentTarget as HTMLElement).dataset.workspaceDrawerId;
      if (!id) return;
      this.state.drawers = this.state.drawers.includes(id) ? this.state.drawers.filter((candidate) => candidate !== id) : [...this.state.drawers, id];
      this.persistAndApply();
    }

    beginWorkResize(event: PointerEvent): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const handle = event.currentTarget as HTMLElement;
      this.resize = { startX: event.clientX, startWidth: this.workPane.getBoundingClientRect().width, pointerId: event.pointerId, handle };
      handle.setPointerCapture(event.pointerId);
      window.addEventListener("pointermove", this.resizeWork);
      window.addEventListener("pointerup", this.finishWorkResize, { once: true });
    }

    beginWorkReorder(event: DragEvent): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      this.draggedWorkKey = (event.currentTarget as HTMLElement).dataset.workViewReorderKey;
      if (this.draggedWorkKey) event.dataTransfer?.setData("text/plain", this.draggedWorkKey);
    }

    allowWorkReorder(event: DragEvent): void {
      if (this.draggedWorkKey) event.preventDefault();
    }

    async finishWorkReorder(event: DragEvent): Promise<void> {
      if (!this.draggedWorkKey) return;
      event.preventDefault();
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const target = event.currentTarget as HTMLElement;
      const views = [...target.parentElement!.querySelectorAll<HTMLElement>("[data-work-view-reorder-key]")];
      const index = views.indexOf(target);
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
      this.selectWorkViewState(key, contextual);
      this.persistAndApply({ focus: true });
    }

    private selectWorkViewState(key: string, contextual: boolean): void {
      this.state.activeWorkViewKey = key;
      this.state.workPaneVisible = true;
      if (this.isPhone) this.state.phoneDestination = `work:${key}`;
      if (contextual) this.element.dataset.activeContextualWork = key;
    }

    private get isPhone(): boolean { return this.media?.matches ?? window.matchMedia("(max-width: 700px)").matches; }
    private get workPane(): HTMLElement { return this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='workPane']")!; }
    private get storageKey(): string { return `atelier:workspace-navigation:${this.workspaceIdValue}`; }

    private restoreState(): PersonalNavigationState {
      const stored = storedNavigation(sessionStorage, this.storageKey);
      return {
        activeAgentId: stored?.activeAgentId,
        activeWorkViewKey: stored?.activeWorkViewKey,
        workPaneVisible: stored?.workPaneVisible ?? false,
        phoneDestination: stored?.phoneDestination ?? "workspace",
        drawers: stored?.drawers ?? [],
      };
    }

    private normalizeState(): void {
      const agents = [...this.element.querySelectorAll<HTMLElement>("[data-agent-conversation-id], [data-workspace-pane-role='agent']")].map((item) => item.dataset.agentConversationId ?? item.dataset.workspacePaneId!).filter(Boolean);
      const workViews = [...this.element.querySelectorAll<HTMLElement>("[data-work-view-key]")].map((item) => item.dataset.workViewKey!);
      if (!this.state.activeAgentId || !agents.includes(this.state.activeAgentId)) this.state.activeAgentId = agents[0];
      if (!this.state.activeWorkViewKey || !workViews.includes(this.state.activeWorkViewKey)) this.state.activeWorkViewKey = workViews[0];
      if (!this.state.activeWorkViewKey) this.state.workPaneVisible = false;
      if (this.state.phoneDestination.startsWith("work:") && !workViews.includes(this.state.phoneDestination.slice(5))) this.state.phoneDestination = `agent:${this.state.activeAgentId!}`;
      if (this.state.phoneDestination.startsWith("agent:") && !agents.includes(this.state.phoneDestination.slice(6))) this.state.phoneDestination = `agent:${this.state.activeAgentId!}`;
      this.persist();
    }

    private activateNewestAttendedWorkView(): boolean {
      const resident = this.element.closest<HTMLElement>(".workspace-detail-resident.visible");
      if (!resident || attentionActivatedResidents.has(resident)) return false;
      attentionActivatedResidents.add(resident);
      const selector = [...this.element.querySelectorAll<HTMLElement>("[data-work-view-key][data-attention-sequence]")]
        .sort((left, right) => Number(right.dataset.attentionSequence) - Number(left.dataset.attentionSequence))[0];
      if (!selector) return false;
      this.selectWorkViewState(selector.dataset.workViewKey!, selector.dataset.workViewKind === "contextual");
      return true;
    }

    private applyDeepLink(): boolean {
      const url = new URL(window.location.href);
      if (!url.pathname.endsWith(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}`)) return false;
      const key = url.searchParams.get("workView");
      if (!key) return false;
      const selector = this.element.querySelector<HTMLElement>(`[data-work-view-key="${CSS.escape(key)}"]`);
      if (!selector) return false;
      this.selectWorkViewState(key, selector.dataset.workViewKind === "contextual");
      this.persist();
      return true;
    }

    private persist(): void {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.state));
    }
    private persistAndApply(options: { focus?: boolean } = {}): void { this.persist(); this.applyState({ emit: true, focus: options.focus }); }

    private applyState(options: { emit: boolean; focus?: boolean }): void {
      const before = [...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")].filter((pane) => visiblePresentationPanes.has(pane));
      this.element.classList.toggle("is-work-pane-open", this.state.workPaneVisible);
      this.element.dataset.phoneDestination = this.state.phoneDestination;
      this.element.dataset.navigationReady = "true";

      this.element.querySelectorAll<HTMLElement>("[data-agent-conversation-id]").forEach((selector) => {
        const active = selector.dataset.agentConversationId === this.state.activeAgentId;
        selector.setAttribute("aria-selected", String(active));
        selector.tabIndex = active ? 0 : -1;
      });
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role='agent']").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.workspacePaneId === this.state.activeAgentId));

      this.element.querySelectorAll<HTMLElement>("[data-work-view-key]").forEach((selector) => {
        const active = selector.dataset.workViewKey === this.state.activeWorkViewKey;
        selector.setAttribute("aria-selected", String(active));
        selector.tabIndex = active ? 0 : -1;
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
      this.element.querySelectorAll<HTMLElement>("[data-more-close-destination]").forEach((closer) => {
        closer.hidden = closer.dataset.moreCloseDestination !== this.state.phoneDestination;
      });
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
        // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
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
    }

    private setWorkWidth(width: number, persist: boolean): void {
      const workspaceWidth = this.element.closest(".fixed-shell-app.is-workspace-pane-open") && window.innerWidth >= 1180 ? 275 : 0;
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
    private residencyVisible = (): void => {
      attentionActivatedResidents.delete(this.element.closest<HTMLElement>(".workspace-detail-resident")!);
      const focusAttendedWorkView = this.activateNewestAttendedWorkView();
      this.persist();
      this.applyState({ emit: true, focus: focusAttendedWorkView });
    };
    private residencyHidden = (): void => this.emitVisibilityChanges([...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")].filter((pane) => visiblePresentationPanes.has(pane)), []);

    private keydown = (event: KeyboardEvent): void => {
      const selector = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[role='tab']") : null;
      if (!selector || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const list = selector.closest("[role='tablist']");
      const selectors = list ? [...list.querySelectorAll<HTMLElement>("[role='tab']")] : [];
      if (selectors.length < 2) return;
      event.preventDefault();
      const index = selectors.indexOf(selector);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? selectors.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + selectors.length) % selectors.length;
      selectors[nextIndex]?.click();
      selectors[nextIndex]?.focus();
    };
  };
}

export function installWorkspacePresentationTurboStream(Turbo: TurboLike, application: PresentationApplication): void {
  Turbo.StreamActions["remove-workspace-resident"] = function removeWorkspaceResident(this: StreamElement): void {
    for (const target of this.targetElements) {
      const resident = target.closest<HTMLElement>(".workspace-detail-resident[data-workspace-id]");
      const workspaceId = resident?.dataset.workspaceId;
      if (workspaceId) document.dispatchEvent(new CustomEvent("atelier:workspace-removed", { detail: { workspaceId } }));
    }
  };
  Turbo.StreamActions["replace-workspace-pane-collections"] = function replaceWorkspacePaneCollections(this: StreamElement): void {
    for (const target of this.targetElements) {
      const replacement = this.templateContent.firstElementChild?.cloneNode(true);
      if (!(replacement instanceof HTMLElement)) throw new Error("Workspace pane collections stream is missing its replacement");
      const visibleWorkspaceId = document.querySelector<HTMLElement>(".workspace-detail-resident.visible[data-workspace-id]")?.dataset.workspaceId;
      const pathWorkspaceId = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
      const workspaceId = visibleWorkspaceId ?? (pathWorkspaceId ? decodeURIComponent(pathWorkspaceId) : undefined);
      if (workspaceId) markActiveWorkspaceRow(replacement, workspaceId);
      for (const project of target.querySelectorAll<HTMLElement>(".fixed-shell-project[data-project-id].is-collapsed")) {
        const id = project.dataset.projectId!;
        const next = replacement.querySelector<HTMLElement>(`.fixed-shell-project[data-project-id="${CSS.escape(id)}"]`);
        next?.classList.add("is-collapsed");
        next?.querySelector<HTMLElement>(".fixed-shell-project-heading")?.setAttribute("aria-expanded", "false");
      }
      target.replaceWith(replacement);
    }
  };
  Turbo.StreamActions["present-work-view"] = function presentWorkView(this: StreamElement): void {
    const key = this.dataset.workViewKey;
    if (!key) throw new Error("present-work-view requires a Work view key");
    for (const target of this.targetElements) {
      if (!target.closest(".workspace-detail-resident.visible")) continue;
      target.querySelector<HTMLButtonElement>(`[data-work-view-key="${CSS.escape(key)}"]`)?.click();
    }
  };
  Turbo.StreamActions["replace-workspace-presentation"] = async function replaceWorkspacePresentation(this: StreamElement): Promise<void> {
    for (const target of this.targetElements) {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
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
