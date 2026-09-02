/// <reference lib="dom" />

import { atelierCableConnectionHeader, phoneViewportMediaQuery, type WorkspaceClientApplication, type WorkspaceClientControllerConstructor, type WorkspaceClientSurfaceVisibilityContext } from "@atelier/shared";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { hydrateWorkViewFrame } from "./work-view-hydration.ts";

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

const visiblePresentationPanes = new WeakSet<HTMLElement>();
const agentPaneWidthStorageKey = "atelier:agent-pane-width";

type HydratableTurboFrame = HTMLElement & {
  readonly complete: boolean;
  loading: "eager" | "lazy";
  loaded: Promise<void>;
  reload(): Promise<void>;
};

const hydratedAgentFrames = new WeakSet<HydratableTurboFrame>();
const attemptedAgentFrames = new WeakSet<HydratableTurboFrame>();
const invalidatedAgentFrames = new WeakSet<HydratableTurboFrame>();
const suspendedAgentFrames = new WeakSet<HydratableTurboFrame>();
const pendingAgentHydrations = new WeakMap<HydratableTurboFrame, Promise<void>>();

async function loadAgentFrameInitially(frame: HydratableTurboFrame): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (frame.hasAttribute("complete")) return;
  if (frame.complete) frame.loading = "eager";
  await frame.loaded;
}

function hydrateAgentFrame(element: HTMLElement, options: { authoritativeReload?: boolean } = {}): Promise<void> {
  // SAFETY: This helper is called only for Atelier-rendered Turbo Frame hydration targets.
  const frame = element as HydratableTurboFrame;
  if (options.authoritativeReload) invalidatedAgentFrames.add(frame);
  if (invalidatedAgentFrames.has(frame)) suspendedAgentFrames.add(frame);
  const pending = pendingAgentHydrations.get(frame);
  if (pending) {
    return invalidatedAgentFrames.has(frame)
      ? pending.then(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0))).then(() => hydrateAgentFrame(frame))
      : pending;
  }
  const authoritativeReload = invalidatedAgentFrames.delete(frame);
  const hydrated = hydratedAgentFrames.has(frame) || frame.hasAttribute("complete");
  if (hydrated && !authoritativeReload) {
    hydratedAgentFrames.add(frame);
    return Promise.resolve();
  }
  const retry = attemptedAgentFrames.has(frame) || hydrated;
  attemptedAgentFrames.add(frame);
  hydratedAgentFrames.delete(frame);
  if (hydrated && frame.loading === "lazy") frame.loading = "eager";
  const hydration = (retry ? frame.reload() : loadAgentFrameInitially(frame))
    .then(() => { hydratedAgentFrames.add(frame); })
    .catch((error) => {
      if (authoritativeReload) invalidatedAgentFrames.add(frame);
      throw error;
    })
    .finally(() => {
    pendingAgentHydrations.delete(frame);
    if (!invalidatedAgentFrames.has(frame)) suspendedAgentFrames.delete(frame);
  });
  pendingAgentHydrations.set(frame, hydration);
  return hydration;
}

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

function persistIntendedWorkView(workspaceId: string, key: string): void {
  const storageKey = workspaceNavigationStorageKey(workspaceId);
  const state = storedNavigation(sessionStorage, storageKey) ?? {};
  sessionStorage.setItem(storageKey, JSON.stringify({ ...state, activeWorkViewKey: key, workPaneVisible: true, phoneDestination: `work:${key}` } satisfies StoredPersonalNavigation));
}

function persistIntendedAgent(workspaceId: string, conversationId: string): void {
  const storageKey = workspaceNavigationStorageKey(workspaceId);
  const state = storedNavigation(sessionStorage, storageKey) ?? {};
  sessionStorage.setItem(storageKey, JSON.stringify({ ...state, activeAgentId: conversationId, phoneDestination: "agents" } satisfies StoredPersonalNavigation));
}

function persistAgentSuccessor(workspaceId: string, closedConversationId: string, successorConversationId: string): void {
  const storageKey = workspaceNavigationStorageKey(workspaceId);
  const state = storedNavigation(sessionStorage, storageKey);
  if (state?.activeAgentId !== closedConversationId) return;
  sessionStorage.setItem(storageKey, JSON.stringify({ ...state, activeAgentId: successorConversationId } satisfies StoredPersonalNavigation));
}

function persistWorkViewSuccessor(workspaceId: string, closedKey: string, successorKey?: string): void {
  const storageKey = workspaceNavigationStorageKey(workspaceId);
  const state = storedNavigation(sessionStorage, storageKey);
  if (state?.activeWorkViewKey !== closedKey) return;
  const next: StoredPersonalNavigation = { ...state, workPaneVisible: successorKey !== undefined, phoneDestination: successorKey ? `work:${successorKey}` : "agents" };
  if (successorKey) next.activeWorkViewKey = successorKey;
  else delete next.activeWorkViewKey;
  sessionStorage.setItem(storageKey, JSON.stringify(next));
}

export function markActiveWorkspaceRow(root: ParentNode, workspaceId: string): void {
  root.querySelectorAll<HTMLElement>(".fixed-shell-workspace-row.active").forEach((row) => {
    row.classList.remove("active");
    row.removeAttribute("aria-current");
  });
  const active = root.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
  active?.classList.add("active");
  active?.setAttribute("aria-current", "page");
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
    private sizeObserver?: ResizeObserver;
    private preferredAgentWidth?: number;
    private resize?: { startX: number; startAgentWidth: number };
    private moreOpen = false;
    private mobileNavigationLayoutFrame?: number;
    private draggedWorkKey?: string;
    private readonly invalidatedAgentGenerations = new Map<string, number>();
    private readonly invalidatedAgentReloads = new Map<string, Promise<void>>();

    connect(): void {
      this.state = this.restoreState();
      this.media = window.matchMedia(phoneViewportMediaQuery);
      this.media.addEventListener("change", this.viewportChanged);
      this.element.addEventListener("keydown", this.keydown);
      this.element.addEventListener("atelier:workspace-residency-visible", this.residencyVisible);
      this.element.addEventListener("atelier:workspace-residency-hidden", this.residencyHidden);
      document.addEventListener("visibilitychange", this.documentVisibilityChanged);
      this.restorePreferences();
      this.sizeObserver = new ResizeObserver(() => {
        this.restorePreferences();
        this.scheduleMobileNavigationLayout();
      });
      this.sizeObserver.observe(this.element);
      this.normalizeState();
      this.applyInitialAttentionIntent();
      this.applyDeepLink();
      this.applyState({ emit: true });
    }

    disconnect(): void {
      this.media?.removeEventListener("change", this.viewportChanged);
      this.element.removeEventListener("keydown", this.keydown);
      this.element.removeEventListener("atelier:workspace-residency-visible", this.residencyVisible);
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
      if (!this.element.querySelector(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(conversationId)}"]`)) return;
      this.state.activeAgentId = conversationId;
      this.state.phoneDestination = "agents";
      this.persistAndApply();
    }

    selectAgentSuccessor(closedConversationId: string, successorConversationId: string): void {
      if (this.state.activeAgentId === closedConversationId) this.state.activeAgentId = successorConversationId;
      this.presentationChanged();
    }

    invalidateAgentFrame(conversationId: string): void {
      const pane = this.element.querySelector<PresentationPane>(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(conversationId)}"]`);
      const frame = pane?.querySelector<HTMLElement>("turbo-frame[data-agent-body-hydration][src]");
      if (!pane || !frame) return;
      // SAFETY: The selector matches only Atelier-rendered Agent Turbo Frame hydration targets.
      const hydratableFrame = frame as HydratableTurboFrame;
      if (pane.dataset.workspaceLogicallyVisible === "true" && visiblePresentationPanes.has(pane)) return;
      this.invalidatedAgentGenerations.set(conversationId, (this.invalidatedAgentGenerations.get(conversationId) ?? 0) + 1);
      invalidatedAgentFrames.add(hydratableFrame);
    }

    selectWorkViewSuccessor(closedKey: string, successorKey?: string): void {
      if (this.state.activeWorkViewKey === closedKey) {
        this.state.activeWorkViewKey = successorKey;
        if (!successorKey) {
          this.state.workPaneVisible = false;
          this.state.phoneDestination = "agents";
        } else if (this.state.phoneDestination === `work:${closedKey}`) {
          this.state.phoneDestination = `work:${successorKey}`;
        }
      }
      this.presentationChanged();
    }

    intendWorkView(key: string): void {
      const selector = this.element.querySelector<HTMLElement>(`[data-work-view-key="${CSS.escape(key)}"]`);
      if (!selector) return;
      const alreadyVisible = this.visiblePanes().some((pane) => pane.dataset.workspacePaneRole === "work" && pane.dataset.workspacePaneId === key);
      this.selectWorkViewState(key, selector.dataset.workViewKind === "contextual");
      this.persist();
      if (this.element.closest(".workspace-detail-resident.visible")) this.applyState({ emit: true, focus: true });
      if (alreadyVisible) this.finishVisibleWorkViewPreparation();
    }

    presentWorkView(key: string): void {
      if (!this.element.closest(".workspace-detail-resident.visible")) return;
      const selector = this.element.querySelector<HTMLElement>(`[data-work-view-key="${CSS.escape(key)}"]`);
      if (!selector) return;
      this.selectWorkViewState(key, selector.dataset.workViewKind === "contextual");
      this.persistAndApply({ focus: true });
    }

    presentationChanged(): void {
      this.normalizeState();
      this.applyState({ emit: true });
    }

    async prepareIntendedSurfaces(options: { authoritativeReload?: boolean } = {}): Promise<void> {
      this.normalizeState();
      this.applyState({ emit: false });
      const agentFrame = this.element.querySelector<HTMLElement>(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(this.state.activeAgentId!)}"] turbo-frame[data-agent-body-hydration][src]`);
      if (agentFrame) await hydrateAgentFrame(agentFrame, options);
      if (!this.state.workPaneVisible || !this.state.activeWorkViewKey) return;
      const workFrame = this.element.querySelector<HTMLElement>(`[data-workspace-pane-role="work"][data-workspace-pane-id="${CSS.escape(this.state.activeWorkViewKey)}"] turbo-frame[data-work-view-hydration][src]`);
      if (workFrame) await hydrateWorkViewFrame(workFrame, options);
      await this.initializeEmbeddedWorkSurface();
    }

    selectedAgentId(): string {
      return this.state.activeAgentId!;
    }

    agentBodyLoaded(event: Event): void {
      // SAFETY: The action is attached directly to the server-rendered Agent Turbo Frame.
      const frame = event.currentTarget as HTMLElement;
      // SAFETY: The action target is the same Atelier-rendered Turbo Frame accepted by hydrateAgentFrame.
      hydratedAgentFrames.add(frame as HydratableTurboFrame);
      const pane = frame.closest<PresentationPane>("[data-workspace-pane-role='agent']");
      requestAnimationFrame(() => {
        if (pane?.dataset.workspaceLogicallyVisible !== "true") return;
        if (pane.dataset.workspacePaneId && this.invalidatedAgentGenerations.has(pane.dataset.workspacePaneId)) return;
        // SAFETY: The action target is the same Atelier-rendered Turbo Frame accepted by hydrateAgentFrame.
        if (suspendedAgentFrames.has(frame as HydratableTurboFrame)) return;
        if (visiblePresentationPanes.has(pane)) {
          // The stable pane survives a Turbo Frame reload, but its Agent controller does not.
          // Re-deliver logical visibility after Stimulus connects the reconstructed body.
          lifecycle.becomeVisible(this.lifecycleContext(pane));
          pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-visible", { bubbles: true, detail: { role: "agent", id: pane.dataset.workspacePaneId } }));
        } else {
          this.emitVisible(pane);
        }
      });
    }

    workBodyLoaded(event: Event): void {
      // SAFETY: The action is attached directly to the server-rendered Work Turbo Frame.
      const frame = event.currentTarget as HTMLElement;
      const pane = frame.closest<PresentationPane>("[data-workspace-pane-role='work']");
      requestAnimationFrame(() => {
        if (pane?.dataset.workspaceLogicallyVisible !== "true") return;
        if (!visiblePresentationPanes.has(pane)) this.emitVisible(pane);
      });
    }

    workBodyWillRender(event: Event): void {
      // SAFETY: The action is attached directly to the server-rendered Work Turbo Frame.
      const frame = event.currentTarget as HTMLElement;
      const pane = frame.closest<PresentationPane>("[data-workspace-pane-role='work']");
      if (!pane || !visiblePresentationPanes.has(pane)) return;
      visiblePresentationPanes.delete(pane);
      lifecycle.noLongerVisible(this.lifecycleContext(pane));
      pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-hidden", { bubbles: true, detail: { role: "work", id: pane.dataset.workspacePaneId } }));
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

    toggleMore(): void {
      this.moreOpen = !this.moreOpen;
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
      const connectionId = window.AtelierCable?.connectionId();
      if (connectionId) headers.set(atelierCableConnectionHeader, connectionId);
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

    private get isPhone(): boolean { return this.media?.matches ?? window.matchMedia(phoneViewportMediaQuery).matches; }
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
      if (!this.state.activeAgentId || !agents.includes(this.state.activeAgentId)) this.state.activeAgentId = agents[0];
      if (!this.state.activeWorkViewKey || !workViews.includes(this.state.activeWorkViewKey)) this.state.activeWorkViewKey = workViews[0];
      if (this.state.phoneDestination.startsWith("work:") && !workViews.includes(this.state.phoneDestination.slice(5))) this.state.phoneDestination = "agents";
      this.persist();
    }

    private applyInitialAttentionIntent(): void {
      const selectors = [...this.element.querySelectorAll<HTMLElement>("[data-work-view-key][data-attention-sequence]")];
      if (!selectors.length) return;
      const latest = selectors.reduce((current, candidate) => Number(candidate.dataset.attentionSequence) > Number(current.dataset.attentionSequence) ? candidate : current);
      this.selectWorkViewState(latest.dataset.workViewKey!, latest.dataset.workViewKind === "contextual");
      this.persist();
    }

    private applyDeepLink(): void {
      const url = new URL(window.location.href);
      if (!url.pathname.endsWith(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}`)) return;
      const key = url.searchParams.get("workView");
      if (!key) return;
      const selector = this.element.querySelector<HTMLElement>(`[data-work-view-key="${CSS.escape(key)}"]`);
      if (!selector) return;
      this.selectWorkViewState(key, selector.dataset.workViewKind === "contextual");
      url.searchParams.delete("workView");
      window.history.replaceState(window.history.state, "", url);
      this.persist();
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
        selector.closest(".action-item")!.classList.toggle("active", active);
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
        destination.setAttribute("aria-current", selected ? "page" : "false");
      });
      this.element.querySelectorAll<HTMLElement>("[data-more-work-key]").forEach((item) => {
        item.setAttribute("aria-checked", String(`work:${item.dataset.moreWorkKey}` === this.state.phoneDestination));
      });
      const moreButton = this.element.querySelector<HTMLElement>("[data-mobile-more]");
      moreButton?.setAttribute("aria-expanded", String(this.moreOpen));
      const moreMenu = this.element.querySelector<HTMLElement>("[data-workspace-presentation-target='moreMenu']");
      if (moreMenu) moreMenu.hidden = !this.moreOpen;
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
      if (pane.dataset.workspacePaneRole === "agent") {
        const frame = pane.querySelector<HTMLElement>("turbo-frame[data-agent-body-hydration][src]");
        const conversationId = pane.dataset.workspacePaneId;
        if (frame && conversationId && this.invalidatedAgentGenerations.has(conversationId)) {
          // SAFETY: The selector matches only Atelier-rendered Agent Turbo Frame hydration targets.
          this.reloadInvalidatedAgentPane(pane, frame as HydratableTurboFrame);
          return;
        }
        // SAFETY: The selector matches only Atelier-rendered Agent Turbo Frame hydration targets.
        if (frame && (invalidatedAgentFrames.has(frame as HydratableTurboFrame) || suspendedAgentFrames.has(frame as HydratableTurboFrame) || pendingAgentHydrations.has(frame as HydratableTurboFrame) || (!frame.hasAttribute("complete") && !hydratedAgentFrames.has(frame as HydratableTurboFrame)))) {
          void hydrateAgentFrame(frame)
            .then(() => { if (pane.dataset.workspaceLogicallyVisible === "true") this.emitVisible(pane); })
            .catch((error) => console.error("Could not hydrate Agent", error));
          return;
        }
      }
      if (pane.dataset.workspacePaneRole === "work") {
        const frame = pane.querySelector<HTMLElement>("turbo-frame[data-work-view-hydration][src]");
        if (frame && !frame.hasAttribute("complete")) {
          void hydrateWorkViewFrame(frame).catch((error) => console.error("Could not hydrate Work view", error));
          return;
        }
      }
      visiblePresentationPanes.add(pane);
      if (pane.dataset.workspacePaneRole === "work") {
        const frame = pane.querySelector<HTMLElement>("turbo-frame[data-work-view-hydration][src]");
        if (frame) void hydrateWorkViewFrame(frame).then(() => this.initializeEmbeddedWorkSurface()).catch((error) => console.error("Could not hydrate Work view", error));
      }
      pane.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]').forEach((frame) => {
        // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
        const controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { becomeVisible?(): void } | null;
        controller?.becomeVisible?.();
      });
      lifecycle.becomeVisible(this.lifecycleContext(pane));
      if (pane.dataset.workspacePaneRole === "work") this.finishVisibleWorkViewPreparation();
      pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-visible", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private reloadInvalidatedAgentPane(pane: PresentationPane, frame: HydratableTurboFrame): void {
      const conversationId = pane.dataset.workspacePaneId!;
      if (this.invalidatedAgentReloads.has(conversationId)) return;
      const reload = (async () => {
        while (true) {
          const generation = this.invalidatedAgentGenerations.get(conversationId)!;
          invalidatedAgentFrames.add(frame);
          suspendedAgentFrames.add(frame);
          await hydrateAgentFrame(frame, { authoritativeReload: true });
          if (this.invalidatedAgentGenerations.get(conversationId) === generation) {
            this.invalidatedAgentGenerations.delete(conversationId);
            return;
          }
        }
      })().finally(() => this.invalidatedAgentReloads.delete(conversationId));
      this.invalidatedAgentReloads.set(conversationId, reload);
      void reload
        .then(() => { if (pane.dataset.workspaceLogicallyVisible === "true") this.emitVisible(pane); })
        .catch((error) => console.error("Could not reload invalidated Agent", error));
    }

    private finishVisibleWorkViewPreparation(): void {
      if (document.visibilityState !== "visible") return;
      document.dispatchEvent(new CustomEvent("atelier:workspace-preparation-request-acknowledged", { detail: { workspaceId: this.workspaceIdValue } }));
    }

    private emitHidden(pane: PresentationPane): void {
      pane.dataset.workspaceLogicallyVisible = "false";
      if (!visiblePresentationPanes.has(pane)) return;
      visiblePresentationPanes.delete(pane);
      lifecycle.noLongerVisible(this.lifecycleContext(pane));
      pane.dispatchEvent(new CustomEvent("atelier:workspace-pane-hidden", { bubbles: true, detail: { role: pane.dataset.workspacePaneRole, id: pane.dataset.workspacePaneId } }));
    }

    private focusActiveSurface(): void {
      if (this.isPhone && this.moreOpen) {
        this.element.querySelector<HTMLElement>(".fixed-shell-more-menu [role='menuitem']:not([hidden]), .fixed-shell-more-menu [role='menuitemradio']:not([hidden])")?.focus();
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

    private viewportChanged = (): void => { this.applyState({ emit: true }); };
    private residencyVisible = (): void => {
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
      if (this.visiblePanes().some((pane) => pane.dataset.workspacePaneRole === "work")) this.finishVisibleWorkViewPreparation();
    };

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
  interface PresentationActions {
    selectAgentById(conversationId: string): void;
    selectAgentSuccessor(closedConversationId: string, successorConversationId: string): void;
    selectWorkViewSuccessor(closedKey: string, successorKey?: string): void;
    presentWorkView(key: string): void;
    intendWorkView(key: string): void;
    invalidateAgentFrame(conversationId: string): void;
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
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.presentWorkView(key);
  };
  Turbo.StreamActions["intend-work-view"] = function intendWorkView(this: StreamElement): void {
    const key = this.dataset.workViewKey;
    if (!key) throw new Error("intend-work-view requires a Work view key");
    const workspaceId = behaviorWorkspaceId(this);
    persistIntendedWorkView(workspaceId, key);
    document.dispatchEvent(new CustomEvent("atelier:workspace-preparation-requested", { detail: { workspaceId } }));
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.intendWorkView(key);
  };
  Turbo.StreamActions["select-agent"] = function selectAgent(this: StreamElement): void {
    const conversationId = this.dataset.conversationId;
    if (!conversationId) throw new Error("select-agent requires a conversation ID");
    const workspaceId = behaviorWorkspaceId(this);
    persistIntendedAgent(workspaceId, conversationId);
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.selectAgentById(conversationId);
  };
  Turbo.StreamActions["select-agent-successor"] = function selectAgentSuccessor(this: StreamElement): void {
    const closedConversationId = this.dataset.closedConversationId;
    const successorConversationId = this.dataset.successorConversationId;
    if (!closedConversationId || !successorConversationId) throw new Error("select-agent-successor requires closed and successor conversation IDs");
    const workspaceId = behaviorWorkspaceId(this);
    persistAgentSuccessor(workspaceId, closedConversationId, successorConversationId);
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.selectAgentSuccessor(closedConversationId, successorConversationId);
  };
  Turbo.StreamActions["select-work-view-successor"] = function selectWorkViewSuccessor(this: StreamElement): void {
    const closedKey = this.dataset.closedWorkViewKey;
    if (!closedKey) throw new Error("select-work-view-successor requires a closed Work view key");
    const workspaceId = behaviorWorkspaceId(this);
    persistWorkViewSuccessor(workspaceId, closedKey, this.dataset.successorWorkViewKey);
    for (const target of this.targetElements) controllerFor(target, workspaceId)?.selectWorkViewSuccessor(closedKey, this.dataset.successorWorkViewKey);
  };
  Turbo.StreamActions["invalidate-workspace-preparation"] = function invalidateWorkspacePreparation(this: StreamElement): void {
    const workspaceId = behaviorWorkspaceId(this);
    const conversationId = this.dataset.conversationId;
    for (const target of this.targetElements) {
      const controller = controllerFor(target, workspaceId);
      if (conversationId) controller?.invalidateAgentFrame(conversationId);
      controller?.presentationChanged();
    }
    document.dispatchEvent(new CustomEvent("atelier:workspace-preparation-invalidated", { detail: { workspaceId } }));
  };
}
