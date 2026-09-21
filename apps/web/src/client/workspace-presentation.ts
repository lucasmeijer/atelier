import { workspaceAgentSelectionEvent } from "@atelier/shared";
/// <reference lib="dom" />

import { phoneLayoutMediaQuery, type WorkspaceClientApplication, type WorkspaceClientControllerConstructor, type WorkspaceClientSurfaceVisibilityContext } from "@atelier/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { liveSurfaceReady, prepareLiveSurface, selectLiveSurface } from "./live-surface.ts";
import { residencyController } from "./workspace-controller-registry.ts";

type PresentationPane = HTMLElement & { dataset: DOMStringMap & { workspacePaneRole?: string; workspacePaneId?: string; workspaceLogicallyVisible?: string } };
const phoneDestinationSchema = Type.Union([
  Type.Literal("agents"),
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

type PresentationApplication = WorkspaceClientApplication;

interface StreamElement extends HTMLElement {
  readonly targetElements: HTMLElement[];
  readonly templateContent: DocumentFragment;
}

interface TurboLike {
  StreamActions: Record<string, (this: StreamElement) => void | Promise<void>>;
}

const appliedWorkIntents = new Map<string, string>();
const navigationIntents = new Map<string, { agent?: string; work?: string }>();

const visiblePresentationPanes = new WeakSet<HTMLElement>();
const agentPaneWidthStorageKey = "atelier:agent-pane-width";

function storedNavigation(storage: Storage, key: string): StoredPersonalNavigation | undefined {
  const value = storage.getItem(key);
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Value.Check(storedPersonalNavigationSchema, parsed)) throw new Error(`invalid personal navigation state at ${key}`);
  return parsed;
}

function workspaceNavigationStorageKey(workspaceId: string): string {
  return `atelier:workspace-navigation:${workspaceId}`;
}

function persistIntendedAgent(workspaceId: string, conversationId: string): void {
  navigationIntents.set(workspaceId, { ...navigationIntents.get(workspaceId), agent: conversationId });
  const storageKey = workspaceNavigationStorageKey(workspaceId);
  const state = storedNavigation(sessionStorage, storageKey) ?? {};
  sessionStorage.setItem(storageKey, JSON.stringify({ ...state, activeAgentId: conversationId, phoneDestination: "agents" } satisfies StoredPersonalNavigation));
}

export function markActiveWorkspaceRow(root: ParentNode, workspaceId: string): void {
  root.querySelectorAll<HTMLElement>("[data-workspace-entry-id][aria-current=\"page\"]").forEach((row) => {
    row.removeAttribute("aria-current");
  });
  const active = root.querySelector<HTMLElement>(`[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
  active?.setAttribute("aria-current", "page");
}

export function createWorkspacePresentationController(
  Controller: WorkspaceClientControllerConstructor,
  application: PresentationApplication,
  lifecycle: PresentationLifecycle,
) {
  return class WorkspacePresentationController extends Controller {
    static values = { workspaceId: String, workIntent: Object };
    declare readonly workIntentValue: { key?: string; revision?: string };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    private state!: PersonalNavigationState;
    private media?: MediaQueryList;
    private sizeObserver?: ResizeObserver;
    private preferredAgentWidth?: number;
    private resize?: { startX: number; startAgentWidth: number };
    private moreOpen = false;
    private mobileNavigationLayoutFrame?: number;
    private draggedWorkKey?: string;

    connect(): void {
      this.state = this.restoreState();
      this.media = window.matchMedia(phoneLayoutMediaQuery);
      this.media.addEventListener("change", this.viewportChanged);
      this.element.addEventListener("atelier:workspace-residency-visible", this.residencyVisible);
      this.element.addEventListener("live:structure", this.structureChanged);
      this.element.addEventListener("atelier:workspace-residency-hidden", this.residencyHidden);
      document.addEventListener("visibilitychange", this.documentVisibilityChanged);
      this.restorePreferences();
      this.sizeObserver = new ResizeObserver(() => {
        this.restorePreferences();
        this.scheduleMobileNavigationLayout();
      });
      this.sizeObserver.observe(this.element);
      this.acceptWorkIntent();
      this.applyDeepLink();
      this.normalizeState();
      this.applyState({ emit: true });
    }

    disconnect(): void {
      this.media?.removeEventListener("change", this.viewportChanged);
      this.element.removeEventListener("atelier:workspace-residency-visible", this.residencyVisible);
      this.element.removeEventListener("live:structure", this.structureChanged);
      this.element.removeEventListener("atelier:workspace-residency-hidden", this.residencyHidden);
      document.removeEventListener("visibilitychange", this.documentVisibilityChanged);
      this.sizeObserver?.disconnect();
      if (this.mobileNavigationLayoutFrame !== undefined) cancelAnimationFrame(this.mobileNavigationLayoutFrame);
      this.visiblePanes().forEach((pane) => this.emitHidden(pane));
    }

    selectAgent(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const id = (event.currentTarget as HTMLElement).dataset.agentConversationId;
      if (!id) return;
      this.state.activeAgentId = id;
      this.state.phoneDestination = "agents";
      this.persistAndApply();
    }

    selectAgentById(conversationId: string): void {
      this.state.activeAgentId = conversationId;
      this.state.phoneDestination = "agents";
      this.persistAndApply();
    }

    presentWorkView(key: string): void {
      navigationIntents.set(this.workspaceIdValue, { ...navigationIntents.get(this.workspaceIdValue), work: key });
      if (!this.element.closest(".workspace-detail-resident.visible")) return;
      const selector = this.element.querySelector<HTMLElement>(`[data-work-view-key="${CSS.escape(key)}"]`);
      this.selectWorkViewState(key, selector?.dataset.workViewKind === "contextual");
      this.persistAndApply({ focus: true });
    }

    workIntentValueChanged(): void {
      if (!this.state) return; // Stimulus initializes values before connect.
      this.acceptWorkIntent();
      this.presentationChanged();
    }

    private acceptWorkIntent(): void {
      const { key, revision } = this.workIntentValue;
      if (!key || !revision || appliedWorkIntents.get(this.workspaceIdValue) === revision) return;
      appliedWorkIntents.set(this.workspaceIdValue, revision);
      navigationIntents.set(this.workspaceIdValue, { ...navigationIntents.get(this.workspaceIdValue), work: key });
    }

    intendedSurfacesReady(): boolean {
      const pane = this.element.querySelector<HTMLElement>(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(this.state.activeAgentId ?? "")}"]`);
      const resident = this.element.closest<HTMLElement>(".workspace-detail-resident")!;
      return liveSurfaceReady(resident) && !pane?.querySelector('[data-agent-presentation-ready="false"]');
    }

    presentationChanged(): void {
      this.normalizeState();
      this.applyState({ emit: true });
    }

    async prepareIntendedSurfaces(): Promise<void> {
      this.normalizeState();
      this.applyState({ emit: false });
      await prepareLiveSurface(this.element.closest<HTMLElement>(".workspace-detail-resident")!);
      await this.initializeEmbeddedWorkSurface();
    }

    selectedAgentId(): string | undefined {
      return this.state.activeAgentId;
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
      const item = event.currentTarget as HTMLElement;
      const key = item.dataset.moreWorkKey;
      if (!key) return;
      this.moreOpen = false;
      this.activateWorkView(key, item.dataset.moreWorkKind === "contextual");
    }

    syncMore(event: ToggleEvent): void {
      this.moreOpen = event.newState === "open";
      if (this.moreOpen) this.selectResidentMobileDestination();
      this.applyState({ emit: false, focus: this.moreOpen });
    }

    closeMore(): void {
      this.moreOpen = false;
      this.applyState({ emit: false });
    }

    selectMobileDestination(event: Event): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const destination = (event.currentTarget as HTMLElement).dataset.mobileDestination as PhoneDestination | undefined;
      if (!destination) return;
      this.selectResidentMobileDestination();
      this.state.phoneDestination = destination;
      if (destination.startsWith("work:")) {
        this.state.activeWorkViewKey = destination.slice(5);
        this.state.workPaneVisible = true;
      }
      this.moreOpen = false;
      this.persistAndApply({ focus: destination.startsWith("work:") });
    }

    confirmClose(event: SubmitEvent): void {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
      const label = (event.currentTarget as HTMLElement).dataset.closeLabel ?? "this destination";
      if (!window.confirm(`Close ${label}? Its live state will be destroyed.`)) event.preventDefault();
    }

    toggleWorkPane(): void {
      this.state.workPaneVisible = !this.state.workPaneVisible;
      this.persistAndApply({ focus: this.state.workPaneVisible });
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
      this.resize = { startX: event.clientX, startAgentWidth: this.agentPane.getBoundingClientRect().width };
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
      const headers = new Headers({ "Content-Type": "application/json", "Accept": "text/vnd.turbo-stream.html" });
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/work-views/reorder`, {
        method: "POST",
        headers,
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
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      this.setAgentWidth(this.agentPane.getBoundingClientRect().width + direction * (event.shiftKey ? 80 : 24), true);
    }

    private activateWorkView(key: string, contextual: boolean): void {
      this.selectResidentMobileDestination();
      this.selectWorkViewState(key, contextual);
      this.persistAndApply({ focus: true });
    }

    private selectResidentMobileDestination(): void {
      this.element.dispatchEvent(new CustomEvent("atelier:mobile-resident-destination-selected", { bubbles: true }));
    }

    private selectWorkViewState(key: string, contextual: boolean): void {
      this.state.activeWorkViewKey = key;
      this.state.workPaneVisible = true;
      this.state.phoneDestination = `work:${key}`;
      if (contextual) this.element.dataset.activeContextualWork = key;
    }

    private get isPhone(): boolean { return this.media?.matches ?? window.matchMedia(phoneLayoutMediaQuery).matches; }
    private get agentPane(): HTMLElement { return this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='agentPane']")!; }
    private get storageKey(): string { return workspaceNavigationStorageKey(this.workspaceIdValue); }

    private restoreState(): PersonalNavigationState {
      const stored = storedNavigation(sessionStorage, this.storageKey);
      return {
        activeAgentId: stored?.activeAgentId,
        activeWorkViewKey: stored?.activeWorkViewKey,
        workPaneVisible: stored?.workPaneVisible ?? false,
        phoneDestination: stored?.phoneDestination ?? "agents",
        drawers: stored?.drawers ?? [],
      };
    }

    private normalizeState(): void {
      const agents = [...this.element.querySelectorAll<HTMLElement>("[data-agent-conversation-id], [data-workspace-pane-role='agent']")].map((item) => item.dataset.agentConversationId ?? item.dataset.workspacePaneId!).filter(Boolean);
      const workViews = [...this.element.querySelectorAll<HTMLElement>("[data-work-view-key]")].map((item) => item.dataset.workViewKey!);
      const intent = navigationIntents.get(this.workspaceIdValue);
      if (intent?.agent) {
        this.state.activeAgentId = intent.agent;
        this.state.phoneDestination = "agents";
        if (agents.includes(intent.agent)) delete intent.agent;
      } else if (!this.state.activeAgentId || !agents.includes(this.state.activeAgentId)) this.state.activeAgentId = agents[0];
      if (intent?.work) {
        const selector = this.element.querySelector<HTMLElement>(`[data-work-view-key="${CSS.escape(intent.work)}"]`);
        this.selectWorkViewState(intent.work, selector?.dataset.workViewKind === "contextual");
        if (workViews.includes(intent.work)) delete intent.work;
      } else if (!this.state.activeWorkViewKey || !workViews.includes(this.state.activeWorkViewKey)) this.state.activeWorkViewKey = workViews[0];
      if (!intent?.work && this.state.phoneDestination.startsWith("work:") && !workViews.includes(this.state.phoneDestination.slice(5))) this.state.phoneDestination = "agents";
      this.persist();
    }

    private applyDeepLink(): void {
      const url = new URL(window.location.href);
      if (!url.pathname.endsWith(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}`)) return;
      const agentId = url.searchParams.get("agent");
      const workViewKey = url.searchParams.get("workView");
      if (agentId) {
        const agent = this.element.querySelector<HTMLElement>(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(agentId)}"]`);
        if (!agent) return;
        this.state.activeAgentId = agentId;
        this.state.phoneDestination = "agents";
      }
      if (workViewKey) {
        const workView = this.element.querySelector<HTMLElement>(`[data-work-view-key="${CSS.escape(workViewKey)}"]`);
        if (!workView) return;
        this.selectWorkViewState(workViewKey, workView.dataset.workViewKind === "contextual");
      }
      if (agentId || workViewKey) this.persist();
    }

    private persist(): void {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.state));
      if (this.element.closest(".workspace-detail-resident.visible")) {
        const url = new URL(location.href);
        if (url.pathname === `/workspaces/${encodeURIComponent(this.workspaceIdValue)}`) {
          if (url.searchParams.get("agent") !== this.state.activeAgentId) url.searchParams.delete("agentTarget");
          if (this.state.activeAgentId) url.searchParams.set("agent", this.state.activeAgentId);
          else url.searchParams.delete("agent");
          if (this.state.workPaneVisible && this.state.activeWorkViewKey) url.searchParams.set("workView", this.state.activeWorkViewKey);
          else url.searchParams.delete("workView");
          history.replaceState({}, "", url);
        }
      }
    }
    private persistAndApply(options: { focus?: boolean } = {}): void { this.persist(); this.applyState({ emit: true, focus: options.focus }); }

    private applyState(options: { emit: boolean; focus?: boolean }): void {
      const before = [...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")].filter((pane) => visiblePresentationPanes.has(pane));
      this.element.classList.toggle("is-work-pane-open", this.state.workPaneVisible);
      this.element.dataset.phoneDestination = this.state.phoneDestination;
      this.element.dataset.navigationReady = "true";
      selectLiveSurface(this.element.closest<HTMLElement>(".workspace-detail-resident")!, this.state.activeAgentId ?? "", this.state.workPaneVisible ? this.state.activeWorkViewKey ?? "" : "");
      const selectedAgentChanged = this.element.dataset.workspaceSelectedAgent !== this.state.activeAgentId;
      this.element.dataset.workspaceSelectedAgent = this.state.activeAgentId ?? "";

      this.element.querySelectorAll<HTMLElement>("[data-agent-conversation-id]").forEach((selector) => {
        const active = selector.dataset.agentConversationId === this.state.activeAgentId;
        selector.setAttribute("aria-selected", String(active));
      });
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role='agent']").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.workspacePaneId === this.state.activeAgentId));
      if (selectedAgentChanged) this.element.dispatchEvent(new CustomEvent(workspaceAgentSelectionEvent, { bubbles: true, detail: { workspaceId: this.workspaceIdValue, conversationId: this.state.activeAgentId } }));

      this.element.querySelectorAll<HTMLElement>("[data-work-view-key]").forEach((selector) => {
        const active = selector.dataset.workViewKey === this.state.activeWorkViewKey;
        selector.setAttribute("aria-selected", String(active));
      });
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role='work']").forEach((pane) => pane.classList.toggle("is-active", pane.dataset.workspacePaneId === this.state.activeWorkViewKey));
      this.element.querySelectorAll<HTMLElement>("[data-mobile-destination]").forEach((destination) => {
        const selected = destination.dataset.mobileDestination === this.state.phoneDestination;
        destination.setAttribute("aria-current", selected ? "page" : "false");
      });
      this.element.querySelectorAll<HTMLElement>("[data-more-work-key]").forEach((item) => {
        item.setAttribute("aria-checked", String(`work:${item.dataset.moreWorkKey}` === this.state.phoneDestination));
      });
      const moreButton = this.element.querySelector<HTMLElement>("[data-mobile-more]");
      moreButton?.setAttribute("aria-expanded", String(this.moreOpen));
      const moreMenu = this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='moreMenu']");
      if (moreMenu?.matches(":popover-open") && !this.moreOpen) moreMenu.hidePopover();
      else if (moreMenu && !moreMenu.matches(":popover-open") && this.moreOpen) moreMenu.showPopover();
      this.scheduleMobileNavigationLayout();
      this.element.querySelectorAll<HTMLElement>("[data-more-close-destination]").forEach((closer) => {
        closer.hidden = closer.dataset.moreCloseDestination !== this.state.phoneDestination;
      });
      this.element.querySelectorAll<HTMLElement>("[data-workspace-drawer]").forEach((drawer) => drawer.classList.toggle("is-open", this.state.drawers.includes(drawer.dataset.workspaceDrawer!)));

      const after = this.visiblePanes();
      const afterSet = new Set(after);
      this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]").forEach((pane) => {
        pane.dataset.workspaceLogicallyVisible = String(afterSet.has(pane));
      });
      if (options.emit) this.emitVisibilityChanges(before, after);
      if (options.focus && document.hasFocus()) this.focusActiveSurface();
    }

    private scheduleMobileNavigationLayout(): void {
      if (this.mobileNavigationLayoutFrame !== undefined) cancelAnimationFrame(this.mobileNavigationLayoutFrame);
      this.mobileNavigationLayoutFrame = requestAnimationFrame(() => {
        this.mobileNavigationLayoutFrame = undefined;
        this.layoutMobileNavigation();
      });
    }

    private layoutMobileNavigation(): void {
      if (!this.isPhone) return;
      const container = this.element.querySelector<HTMLElement>("[data-mobile-overflow-container]");
      if (!container) return;
      const destinations = [...container.querySelectorAll<HTMLElement>("[data-mobile-work-key]")];
      const overflowItems = new Map([...this.element.querySelectorAll<HTMLElement>("[data-more-work-key]")].map((item) => [item.dataset.moreWorkKey!, item]));
      destinations.forEach((destination) => { destination.hidden = false; });
      overflowItems.forEach((item) => { item.hidden = true; });

      // Try roomy spacing first, then compact before moving views into More.
      container.classList.remove("is-compact");
      container.classList.toggle("is-compact", container.scrollWidth > container.clientWidth);

      const overflowed: HTMLElement[] = [];
      for (let index = destinations.length - 1; container.scrollWidth > container.clientWidth && index >= 0; index -= 1) {
        const destination = destinations[index]!;
        destination.hidden = true;
        overflowed.push(destination);
        overflowItems.get(destination.dataset.mobileWorkKey!)!.hidden = false;
      }

      const separator = this.element.querySelector<HTMLElement>("[data-mobile-overflow-separator]");
      if (separator) separator.hidden = overflowed.length === 0;
      const attention = this.element.querySelector<HTMLElement>("[data-mobile-overflow-attention]");
      if (attention) attention.hidden = !overflowed.some((destination) => destination.querySelector(".status-dot.attention"));
      const selectedDestination = destinations.find((destination) => destination.dataset.mobileDestination === this.state.phoneDestination);
      const secondarySelected = selectedDestination?.hidden === true;
      this.element.querySelector<HTMLElement>("[data-mobile-more]")?.setAttribute("aria-current", secondarySelected ? "page" : "false");
    }

    private visiblePanes(): PresentationPane[] {
      if (!this.element.closest(".workspace-detail-resident.visible")) return [];
      const selector = this.isPhone
        ? this.state.phoneDestination === "agents" ? `[data-workspace-pane-role='agent'].is-active` : `[data-workspace-pane-role='work'].is-active`
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
      pane.dataset.workspaceSurfaceVisible = "true";
      pane.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]').forEach((frame) => {
        // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
        const controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { becomeVisible?(): void } | null;
        controller?.becomeVisible?.();
      });
      lifecycle.becomeVisible(this.lifecycleContext(pane));
      pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-visible", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private emitHidden(pane: PresentationPane): void {
      pane.dataset.workspaceLogicallyVisible = "false";
      if (!visiblePresentationPanes.has(pane)) return;
      visiblePresentationPanes.delete(pane);
      pane.dataset.workspaceSurfaceVisible = "false";
      lifecycle.noLongerVisible(this.lifecycleContext(pane));
      pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-hidden", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private focusActiveSurface(): void {
      if (this.isPhone && this.moreOpen) {
        this.element.querySelector<HTMLElement>("[data-workspace-presentation-target~=\"moreMenu\"] [role='menuitem']:not([hidden]), [data-workspace-presentation-target~=\"moreMenu\"] [role='menuitemradio']:not([hidden])")?.focus();
        return;
      }
      this.visiblePanes().at(-1)?.focus({ preventScroll: true });
    }

    private async initializeEmbeddedWorkSurface(): Promise<void> {
      if (!this.state.activeWorkViewKey) return;
      const pane = this.element.querySelector<HTMLElement>(`[data-workspace-pane-role="work"][data-workspace-pane-id="${CSS.escape(this.state.activeWorkViewKey)}"]`);
      const frames = pane?.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]') ?? [];
      await Promise.all([...frames].map(async (frame) => {
        // SAFETY: The registered workspace-app-frame controller exposes the preparation method below.
        let controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { loadAndWait(): Promise<void> } | null;
        if (!controller) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          // SAFETY: The registered workspace-app-frame controller exposes the preparation method below.
          controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { loadAndWait(): Promise<void> } | null;
        }
        if (!controller) throw new Error("Embedded Work surface did not connect");
        await controller.loadAndWait();
      }));
    }

    private restorePreferences(): void {
      if (this.preferredAgentWidth === undefined) {
        const stored = Number(localStorage.getItem(agentPaneWidthStorageKey));
        const defaultWidth = Number.parseFloat(getComputedStyle(this.element).getPropertyValue("--fixed-agent-width"));
        this.preferredAgentWidth = Number.isFinite(stored) && stored > 0 ? stored : defaultWidth;
      }
      this.setAgentWidth(this.preferredAgentWidth);
    }

    private setAgentWidth(width: number, persist = false): void {
      const gap = Number.parseFloat(getComputedStyle(this.element).getPropertyValue("--fixed-shell-gap"));
      const maximum = this.element.clientWidth - 360 - gap;
      const bounded = Math.max(380, Math.min(width, maximum));
      this.element.style.setProperty("--fixed-agent-width", `${bounded}px`);
      if (persist) {
        this.preferredAgentWidth = bounded;
        localStorage.setItem(agentPaneWidthStorageKey, String(bounded));
      }
    }

    private resizeWork = (event: PointerEvent): void => {
      if (!this.resize) return;
      this.setAgentWidth(this.resize.startAgentWidth + event.clientX - this.resize.startX);
    };

    private finishWorkResize = (): void => {
      if (!this.resize) return;
      window.removeEventListener("pointermove", this.resizeWork);
      this.preferredAgentWidth = this.agentPane.getBoundingClientRect().width;
      localStorage.setItem(agentPaneWidthStorageKey, String(this.preferredAgentWidth));
      this.resize = undefined;
    };

    private structureChanged = (): void => { this.presentationChanged(); };
    private viewportChanged = (): void => { this.applyState({ emit: true }); };
    private residencyVisible = (): void => {
      this.applyDeepLink();
      this.persist();
      this.applyState({ emit: true });
    };
    private residencyHidden = (): void => {
      const panes = [...this.element.querySelectorAll<PresentationPane>("[data-workspace-pane-role]")];
      panes.forEach((pane) => { pane.dataset.workspaceLogicallyVisible = "false"; });
      this.emitVisibilityChanges(panes.filter((pane) => visiblePresentationPanes.has(pane)), []);
    };
    private documentVisibilityChanged = (): void => {
      if (document.visibilityState !== "visible") return;
    };
  };
}

export function installWorkspacePresentationTurboStream(Turbo: TurboLike, application: PresentationApplication): void {
  interface PresentationActions {
    selectAgentById(conversationId: string): void;
    presentWorkView(key: string): void;
    presentationChanged(): void;
  }
  const controllerFor = (target: HTMLElement, workspaceId: string): PresentationActions | null => {
    const presentation = target.matches("[data-controller~='workspace-presentation']")
      ? target
      : target.querySelector<HTMLElement>(`.fixed-workspace-presentation[data-workspace-id="${CSS.escape(workspaceId)}"]`);
    // SAFETY: The server-rendered presentation element is connected to the registered controller exposing these actions.
    return presentation ? application.getControllerForElementAndIdentifier(presentation, "workspace-presentation") as PresentationActions | null : null;
  };
  const behaviorWorkspaceId = (stream: StreamElement): string => {
    const workspaceId = stream.dataset.workspaceId;
    if (!workspaceId) throw new Error(`${stream.getAttribute("action")} requires a Workspace ID`);
    return workspaceId;
  };
  Turbo.StreamActions["unselect-workspace"] = function unselectWorkspace(this: StreamElement): void {
    residencyController()?.unselectWorkspace(behaviorWorkspaceId(this));
  };
  Turbo.StreamActions["remove-workspace-resident"] = function removeWorkspaceResident(this: StreamElement): void {
    for (const target of this.targetElements) {
      const resident = target.closest<HTMLElement>(".workspace-detail-resident[data-workspace-id]");
      const workspaceId = resident?.dataset.workspaceId;
      if (workspaceId) document.dispatchEvent(new CustomEvent("atelier:workspace-removed", { detail: { workspaceId } }));
    }
  };

  Turbo.StreamActions["workspace-pane-changed"] = function workspacePaneChanged(this: StreamElement): void {
    for (const target of this.targetElements) {
      const visibleWorkspaceId = document.querySelector<HTMLElement>(".workspace-detail-resident.visible[data-workspace-id]")?.dataset.workspaceId;
      const pathWorkspaceId = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
      const workspaceId = visibleWorkspaceId ?? (pathWorkspaceId ? decodeURIComponent(pathWorkspaceId) : undefined);
      if (workspaceId) markActiveWorkspaceRow(target, workspaceId);
    }
    document.dispatchEvent(new CustomEvent("atelier:workspace-pane-changed"));
  };
  Turbo.StreamActions["present-work-view"] = function presentWorkView(this: StreamElement): void {
    const key = this.dataset.workViewKey;
    if (!key) throw new Error("present-work-view requires a Work view key");
    const workspaceId = behaviorWorkspaceId(this);
    navigationIntents.set(workspaceId, { ...navigationIntents.get(workspaceId), work: key });
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.presentWorkView(key);
  };

  Turbo.StreamActions["select-agent"] = function selectAgent(this: StreamElement): void {
    const conversationId = this.dataset.conversationId;
    if (!conversationId) throw new Error("select-agent requires a conversation ID");
    const workspaceId = behaviorWorkspaceId(this);
    persistIntendedAgent(workspaceId, conversationId);
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.selectAgentById(conversationId);
  };

}
