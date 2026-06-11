/// <reference lib="dom" />

import {
  createAgentAttachmentsController,
  createAgentAutosubmitController,
  createAgentElapsedController,
  createAgentNoticeController,
  createAgentPaneController,
  createAgentTermController,
  registerAgentStreamActions,
  startAgentTab,
} from "@atelier/agent/client";
import { createBrowserAddressController, createBrowserPaneController } from "@atelier/browser/client";
import { createTerminalPaneController, initializeTerminalTheme, startTerminal, startTerminalTab } from "@atelier/terminal/client";

declare global {
  interface Window {
    Stimulus: {
      Application: { start(): { register(identifier: string, controllerConstructor: unknown): void; getControllerForElementAndIdentifier(element: Element, identifier: string): unknown } };
      Controller: new (...args: unknown[]) => { element: Element };
    };
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

async function waitForStimulus(): Promise<typeof window.Stimulus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (window.Stimulus?.Application && window.Stimulus.Controller) return window.Stimulus;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Stimulus did not initialize before workspace.js");
}

const { Application, Controller } = await waitForStimulus();

initializeTerminalTheme();
registerAgentStreamActions();

class WorkspaceShellController extends Controller {
  static targets = ["sidebar", "toggle"];
  declare readonly element: HTMLElement;
  declare readonly sidebarTarget: HTMLElement;
  declare readonly hasSidebarTarget: boolean;
  declare readonly toggleTargets: HTMLButtonElement[];
  private readonly storageKey = "atelier.workspaceSidebar";
  private resize?: { startX: number; startWidth: number; pointerId: number; handle: HTMLElement };

  connect(): void {
    const state = this.savedState();
    if (state.width) this.setWidth(state.width);
    this.setCollapsed(Boolean(state.collapsed));
  }

  toggle(): void {
    this.setCollapsed(!this.element.classList.contains("workspace-shell-collapsed"), { persist: true });
  }

  startResize(event: PointerEvent): void {
    if (this.element.classList.contains("workspace-shell-collapsed") || !this.hasSidebarTarget) return;
    const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (!handle) return;
    event.preventDefault();
    this.resize = { startX: event.clientX, startWidth: this.sidebarTarget.getBoundingClientRect().width, pointerId: event.pointerId, handle };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-shell-resizing");
    window.addEventListener("pointermove", this.pointerMove);
    window.addEventListener("pointerup", this.pointerUp, { once: true });
  }

  private pointerMove = (event: PointerEvent): void => {
    if (!this.resize) return;
    this.setWidth(this.resize.startWidth + event.clientX - this.resize.startX);
  };

  private pointerUp = (): void => {
    window.removeEventListener("pointermove", this.pointerMove);
    document.body.classList.remove("workspace-shell-resizing");
    const width = this.currentWidth();
    this.resize = undefined;
    this.saveState({ ...this.savedState(), width });
  };

  private setCollapsed(collapsed: boolean, options: { persist?: boolean } = {}): void {
    this.element.classList.toggle("workspace-shell-collapsed", collapsed);
    this.toggleTargets.forEach((button) => {
      button.textContent = collapsed ? "›" : "‹";
      button.setAttribute("aria-label", collapsed ? "Expand workspace list" : "Collapse workspace list");
      button.title = collapsed ? "Expand workspace list" : "Collapse workspace list";
    });
    if (options.persist) this.saveState({ ...this.savedState(), collapsed });
  }

  private setWidth(width: number): void {
    const clamped = Math.max(260, Math.min(720, width));
    this.element.style.setProperty("--workspace-sidebar-width", `${clamped}px`);
  }

  private currentWidth(): number {
    return this.hasSidebarTarget ? this.sidebarTarget.getBoundingClientRect().width : 360;
  }

  private savedState(): { width?: number; collapsed?: boolean } {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey) || "{}") as { width?: number; collapsed?: boolean };
    } catch {
      return {};
    }
  }

  private saveState(state: { width?: number; collapsed?: boolean }): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(state));
    } catch {
      // Ignore unavailable storage.
    }
  }
}

class WorkspaceTabsController extends Controller {
  static values = { workspaceId: String, groupId: String, initialTab: String };
  declare readonly element: HTMLElement;
  declare readonly workspaceIdValue: string;
  declare readonly groupIdValue: string;
  declare readonly initialTabValue: string;
  declare readonly hasInitialTabValue: boolean;

  connect(): void {
    if (this.hasInitialTabValue && this.initialTabValue) {
      this.activateTab(this.initialTabValue, { persist: false });
      return;
    }
    const activeTerminal = this.root.querySelector<HTMLElement>(".tab-pane.active[data-tab-pane^='terminal:']");
    const title = activeTerminal?.dataset.tabPane?.slice("terminal:".length);
    if (title) void startTerminal(this.workspaceIdValue, title);
  }

  private get root(): ParentNode {
    return this.element.closest("[data-workspace-id]") ?? document;
  }

  activate(event: Event & { params?: { tab?: string } }): void {
    const tabName = event.params?.tab ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.tab : undefined);
    if (!tabName) return;
    this.activateTab(tabName);
  }

  async close(event: Event & { params?: { tab?: string } }): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const tabName = event.params?.tab ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.tab : undefined);
    if (!tabName) return;
    const html = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/tabs/${encodeURIComponent(tabName)}/close`, {
      method: "POST",
      headers: { "Accept": "text/vnd.turbo-stream.html" },
    }).then((response) => response.text());
    window.Turbo?.renderStreamMessage(html);
  }

  stopPropagation(event: Event): void {
    event.stopPropagation();
  }

  activateTab(tabName: string, options: { persist?: boolean } = {}): void {
    this.element.querySelectorAll<HTMLElement>(".group-tab[data-tab]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
      tab.classList.toggle("muted", tab.dataset.tab !== tabName);
    });
    this.group.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.tabPane === tabName);
    });

    startTerminalTab(this.workspaceIdValue, tabName);
    startAgentTab(application, tabName, this.workspaceIdValue);
    startWorkspaceAppFrames(this.group, tabName);
    if (options.persist !== false) void this.persistActiveTab(tabName);
  }

  private get group(): ParentNode & Element {
    return this.element.closest(".workspace-group") ?? this.root as ParentNode & Element;
  }

  private async persistActiveTab(tabName: string): Promise<void> {
    await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/view-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeTab: tabName, groupId: this.groupIdValue }),
    }).catch(() => undefined);
  }
}

class WorkspaceTabCloseController extends Controller {
  static values = { label: String };
  declare readonly labelValue: string;

  confirm(event: SubmitEvent): void {
    const label = this.labelValue || "this tab";
    if (!window.confirm(`Close ${label}?`)) event.preventDefault();
  }
}

class WorkspaceGroupsController extends Controller {
  static targets = ["group"];
  static values = { workspaceId: String };
  declare readonly element: HTMLElement;
  declare readonly groupTargets: HTMLElement[];
  declare readonly workspaceIdValue: string;
  private dragged?: { tab: string; fromGroup: string };
  private resize?: { index: number; startX: number; sizes: number[]; totalWidth: number };

  dragStart(event: DragEvent): void {
    const tab = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const tabName = tab?.dataset.tab;
    const groupId = tab?.dataset.groupId;
    if (!tabName || !groupId) return;
    this.dragged = { tab: tabName, fromGroup: groupId };
    this.element.classList.add("dragging-tab");
    event.dataTransfer?.setData("text/plain", tabName);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  dragEnd(): void {
    this.dragged = undefined;
    this.element.classList.remove("dragging-tab");
    this.clearDropTargets();
  }

  dragOver(event: DragEvent): void {
    if (!this.dragged) return;
    event.preventDefault();
    this.highlightDropTarget(event);
  }

  dragLeave(event: DragEvent): void {
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (target?.matches("[data-new-group-drop-zone]")) target.classList.remove("drop-target");
  }

  async drop(event: DragEvent): Promise<void> {
    if (!this.dragged) return;
    event.preventDefault();
    const target = event.target instanceof HTMLElement ? event.target : event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    if (target?.closest<HTMLElement>("[data-new-group-drop-zone]")) {
      this.clearDropTargets();
      await this.renderStream(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/layout/move-tab`, { tab: this.dragged.tab, fromGroup: this.dragged.fromGroup, newGroup: true });
      this.dragged = undefined;
      this.element.classList.remove("dragging-tab");
      return;
    }
    const group = target?.closest<HTMLElement>(".workspace-group");
    const toGroup = group?.dataset.groupId;
    if (!toGroup) return;
    const targetTab = target?.closest<HTMLElement>(".group-tab[data-tab]");
    const baseIndex = targetTab ? Number(targetTab.dataset.tabIndex ?? 0) : group.querySelectorAll(".group-tab[data-tab]").length;
    const after = targetTab?.classList.contains("drop-after") ? 1 : 0;
    let toIndex = baseIndex + after;
    const fromIndex = this.dragged.fromGroup === toGroup ? Number(this.element.querySelector<HTMLElement>(`.group-tab[data-tab="${CSS.escape(this.dragged.tab)}"]`)?.dataset.tabIndex ?? -1) : -1;
    if (fromIndex >= 0 && fromIndex < toIndex) toIndex -= 1;
    this.clearDropTargets();
    await this.renderStream(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/layout/move-tab`, { tab: this.dragged.tab, fromGroup: this.dragged.fromGroup, toGroup, toIndex });
    this.dragged = undefined;
    this.element.classList.remove("dragging-tab");
  }

  startResize(event: PointerEvent): void {
    const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const index = Number(handle?.dataset.resizerIndex ?? -1);
    if (index < 0) return;
    this.resize = { index, startX: event.clientX, sizes: this.sizes(), totalWidth: this.element.getBoundingClientRect().width };
    handle?.setPointerCapture(event.pointerId);
    window.addEventListener("pointermove", this.pointerMove);
    window.addEventListener("pointerup", this.pointerUp, { once: true });
  }

  private pointerMove = (event: PointerEvent): void => {
    if (!this.resize) return;
    const { index, startX, sizes, totalWidth } = this.resize;
    const delta = (event.clientX - startX) / Math.max(totalWidth, 1);
    const next = [...sizes];
    next[index] = Math.max(0.08, (next[index] ?? 0) + delta);
    next[index + 1] = Math.max(0.08, (next[index + 1] ?? 0) - delta);
    this.applySizes(next);
  };

  private pointerUp = async (): Promise<void> => {
    window.removeEventListener("pointermove", this.pointerMove);
    const sizes = this.sizes();
    this.resize = undefined;
    await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/layout/resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sizes }),
    }).catch(() => undefined);
  };

  private highlightDropTarget(event: DragEvent): void {
    this.clearDropTargets();
    const target = event.target instanceof HTMLElement ? event.target : event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const newGroupDropZone = target?.closest<HTMLElement>("[data-new-group-drop-zone]");
    if (newGroupDropZone) {
      newGroupDropZone.classList.add("drop-target");
      return;
    }
    const group = target?.closest<HTMLElement>(".workspace-group");
    if (!group) return;
    group.classList.add("drop-target");
    const tab = target?.closest<HTMLElement>(".group-tab[data-tab]");
    if (tab) {
      const rect = tab.getBoundingClientRect();
      tab.classList.add(event.clientX > rect.left + rect.width / 2 ? "drop-after" : "drop-before");
      return;
    }
    const tabs = [...group.querySelectorAll<HTMLElement>(".group-tab[data-tab]")];
    const nearest = tabs.find((candidate) => event.clientX < candidate.getBoundingClientRect().left + candidate.getBoundingClientRect().width / 2);
    if (nearest) nearest.classList.add("drop-before");
    else tabs.at(-1)?.classList.add("drop-after");
  }

  private clearDropTargets(): void {
    this.element.querySelectorAll<HTMLElement>(".drop-target,.drop-before,.drop-after").forEach((element) => element.classList.remove("drop-target", "drop-before", "drop-after"));
  }

  private sizes(): number[] {
    return this.groupTargets.map((group) => Number.parseFloat(getComputedStyle(group).getPropertyValue("--group-size")) || 1);
  }

  private applySizes(sizes: number[]): void {
    const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
    this.groupTargets.forEach((group, index) => group.style.setProperty("--group-size", String((sizes[index] ?? 1) / total)));
  }

  private async renderStream(url: string, body: unknown): Promise<void> {
    const html = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "text/vnd.turbo-stream.html" },
      body: JSON.stringify(body),
    }).then((response) => response.text());
    window.Turbo?.renderStreamMessage(html);
  }
}

class ModalController extends Controller {
  static values = { autoShow: Boolean };
  declare readonly element: HTMLDialogElement;
  declare readonly autoShowValue: boolean;

  connect(): void {
    if (this.autoShowValue && !this.element.open) this.element.showModal();
  }

  close(): void {
    this.element.close();
  }
}

class ModalOpenerController extends Controller {
  static values = { targetId: String };
  declare readonly element: HTMLElement;
  declare readonly targetIdValue: string;

  open(): void {
    const dialog = document.getElementById(this.targetIdValue) as HTMLDialogElement | null;
    if (dialog && !dialog.open) dialog.showModal();
  }
}

class WorkspaceResidencyController extends Controller {
  static targets = ["resident", "empty", "loading"];
  static values = { maxResident: Number };
  declare readonly element: HTMLElement;
  declare readonly residentTargets: HTMLElement[];
  declare readonly emptyTargets: HTMLElement[];
  declare readonly loadingTargets: HTMLElement[];
  declare readonly maxResidentValue: number;
  private selectionSeq = 0;

  async selectWorkspace(workspaceId: string, href: string): Promise<void> {
    // Update the URL first: selection state is derived from it, and stream
    // broadcasts arriving while the resident loads must not flip selection back.
    const seq = ++this.selectionSeq;
    history.pushState({}, "", href);
    const existing = this.residentTargets.find((resident) => resident.dataset.workspaceId === workspaceId);
    if (existing) {
      this.activateResident(existing);
      return;
    }

    // Hide the previous workspace immediately: it must not keep receiving
    // input (e.g. typing into its agent field) while the new one loads.
    this.showLoading();

    let resident: HTMLElement;
    try {
      resident = await this.fetchResident(href);
    } catch (error) {
      if (seq !== this.selectionSeq) return;
      this.showLoadError(error);
      return;
    }
    this.element.appendChild(resident);
    // Only activate if no newer selection happened while we were fetching;
    // the resident stays cached either way.
    if (seq === this.selectionSeq) this.activateResident(resident);
    this.evictIfNeeded();
  }

  residentTargetConnected(resident: HTMLElement): void {
    // Broadcast residents (e.g. the boot placeholder being replaced by the real
    // detail) arrive without an "active" class; activate them only if this
    // client is currently looking at that workspace.
    if (resident.classList.contains("active")) return;
    const workspaceId = resident.dataset.workspaceId;
    if (!workspaceId) return;
    if (location.pathname === `/workspaces/${encodeURIComponent(workspaceId)}`) this.activateResident(resident);
  }

  removeWorkspace(workspaceId: string): void {
    const resident = this.residentTargets.find((candidate) => candidate.dataset.workspaceId === workspaceId);
    if (!resident) return;
    const wasActive = resident.classList.contains("active");
    resident.remove();
    if (wasActive) this.showEmpty();
  }

  hasWorkspace(workspaceId: string): boolean {
    return this.residentTargets.some((resident) => resident.dataset.workspaceId === workspaceId);
  }

  activeWorkspaceId(): string | undefined {
    return this.residentTargets.find((resident) => resident.classList.contains("active"))?.dataset.workspaceId;
  }

  private showEmpty(): void {
    this.residentTargets.forEach((resident) => resident.classList.remove("active"));
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    this.emptyTargets.forEach((empty) => { empty.hidden = false; });
  }

  private showLoading(): void {
    this.residentTargets.forEach((resident) => resident.classList.remove("active"));
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => {
      loading.hidden = false;
      const pad = loading.querySelector<HTMLElement>(".pad");
      if (pad) pad.innerHTML = `<span class="status-spinner"></span> Loading workspace…`;
    });
  }

  private showLoadError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.residentTargets.forEach((resident) => resident.classList.remove("active"));
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => {
      loading.hidden = false;
      const pad = loading.querySelector<HTMLElement>(".pad");
      if (pad) pad.textContent = `Could not load workspace: ${message}`;
    });
  }

  private async fetchResident(href: string): Promise<HTMLElement> {
    const url = new URL(href, location.href);
    url.searchParams.set("resident", "1");
    const html = await fetch(url, { headers: { "Accept": "text/html" } }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    });
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const resident = template.content.firstElementChild;
    if (!(resident instanceof HTMLElement)) throw new Error("Workspace response did not include a resident view");
    return resident;
  }

  private activateResident(resident: HTMLElement): void {
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    this.residentTargets.forEach((candidate) => candidate.classList.toggle("active", candidate === resident));
    resident.dataset.lastActivatedAt = String(Date.now());
    const tabs = resident.querySelector<HTMLElement>('[data-controller~="workspace-tabs"]');
    const controller = tabs ? application.getControllerForElementAndIdentifier(tabs, "workspace-tabs") as WorkspaceTabsController | null : null;
    const activeTab = tabs?.querySelector<HTMLElement>(".group-tab.active[data-tab]")?.dataset.tab;
    if (activeTab) controller?.activateTab(activeTab, { persist: false });
  }

  private evictIfNeeded(): void {
    const max = this.maxResidentValue || 10;
    const residents = [...this.residentTargets];
    if (residents.length <= max) return;
    residents
      .filter((resident) => !resident.classList.contains("active"))
      .sort((a, b) => Number(a.dataset.lastActivatedAt ?? 0) - Number(b.dataset.lastActivatedAt ?? 0))
      .slice(0, residents.length - max)
      .forEach((resident) => resident.remove());
  }
}

function residencyController(): WorkspaceResidencyController | null {
  const residency = document.querySelector<HTMLElement>('[data-controller~="workspace-residency"]');
  return residency ? application.getControllerForElementAndIdentifier(residency, "workspace-residency") as WorkspaceResidencyController | null : null;
}

/**
 * Owns all per-client list state: which row is "active" and the optimistic
 * pending-delete feedback. Broadcast HTML from the server never carries this.
 */
class WorkspaceListController extends Controller {
  declare readonly element: HTMLElement;
  private readonly onStreamRender = (event: Event): void => {
    // Turbo applies stream renders after the next repaint, so wrap the render
    // callback to re-sync only after the DOM change actually happened.
    const detail = (event as CustomEvent).detail as { render?: (element: Element) => Promise<void> } | undefined;
    const original = detail?.render;
    if (detail && original) {
      detail.render = async (element: Element) => {
        await original(element);
        this.sync();
      };
      return;
    }
    queueMicrotask(() => this.sync());
  };

  connect(): void {
    document.addEventListener("turbo:before-stream-render", this.onStreamRender);
    this.sync();
  }

  disconnect(): void {
    document.removeEventListener("turbo:before-stream-render", this.onStreamRender);
  }

  select(event: Event): void {
    const link = event.currentTarget instanceof HTMLAnchorElement ? event.currentTarget : null;
    const row = link?.closest<HTMLElement>(".workspace-row") ?? null;
    if (!row || !link) return;
    if (row.dataset.phase !== "ready" || row.classList.contains("pending-delete")) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const workspaceId = row.dataset.workspaceId;
    if (workspaceId) void residencyController()?.selectWorkspace(workspaceId, link.href);
    this.markActive(workspaceId);
  }

  async createWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
    if (!form) return;
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']");
    button?.setAttribute("disabled", "");
    try {
      const response = await fetch(form.action, {
        method: form.method || "POST",
        headers: { Accept: "text/vnd.turbo-stream.html" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (html) window.Turbo?.renderStreamMessage(html);
      const location = response.headers.get("location");
      if (!location) return;
      const url = new URL(location, window.location.href);
      const workspaceId = decodeURIComponent(url.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1] ?? "");
      if (!workspaceId) return;
      this.markActive(workspaceId);
      void residencyController()?.selectWorkspace(workspaceId, url.pathname);
    } catch (error) {
      console.error("Could not create workspace", error);
    } finally {
      button?.removeAttribute("disabled");
    }
  }

  rowClicked(event: Event): void {
    // Make the whole row clickable, not just the title link.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("a, button, input, textarea, form")) return;
    const row = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    row?.querySelector<HTMLAnchorElement>("a.row-main")?.click();
  }

  deleteStarted(event: Event): void {
    const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
    const row = form?.closest<HTMLElement>(".workspace-row");
    row?.classList.add("pending-delete");
    const button = form?.querySelector<HTMLButtonElement>("button");
    if (button) {
      button.disabled = true;
      button.innerHTML = `<span class="status-spinner sm" aria-label="Deleting"></span>`;
    }
  }

  private currentWorkspaceId(): string | undefined {
    const fromPath = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
    if (fromPath) return decodeURIComponent(fromPath);
    return residencyController()?.activeWorkspaceId();
  }

  private markActive(workspaceId: string | undefined): void {
    this.element.querySelectorAll<HTMLElement>(".workspace-row.active").forEach((row) => row.classList.remove("active"));
    if (!workspaceId) return;
    this.element.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"]`)?.classList.add("active");
  }

  private sync(): void {
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) {
      this.markActive(undefined);
      return;
    }
    const row = this.element.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"]`);
    if (!row) {
      // The workspace we were looking at disappeared (deleted here or elsewhere).
      const residency = residencyController();
      residency?.removeWorkspace(workspaceId);
      if (location.pathname === `/workspaces/${encodeURIComponent(workspaceId)}`) history.replaceState({}, "", "/");
      this.markActive(undefined);
      return;
    }
    this.markActive(workspaceId);
  }
}

class GlobalFilterController extends Controller {
  declare readonly element: HTMLInputElement;
  filter(): void {
    const q = this.element.value.toLowerCase();
    document.querySelectorAll<HTMLElement>(".table .row:not(.head)").forEach((row) => {
      row.style.display = row.textContent?.toLowerCase().includes(q) ? "" : "none";
    });
  }
}

class WorkspaceAppFrameController extends Controller {
  static values = { workspaceId: String, appKey: String, initialPath: String };
  declare readonly element: HTMLIFrameElement;
  declare readonly workspaceIdValue: string;
  declare readonly appKeyValue: string;
  declare readonly initialPathValue: string;
  declare readonly hasInitialPathValue: boolean;

  connect(): void {
    if (this.isActivePane()) this.load();
  }

  activate(): void {
    this.load();
  }

  load(): void {
    const port = window.location.port ? `:${window.location.port}` : "";
    const path = this.hasInitialPathValue && this.initialPathValue ? this.initialPathValue : "/";
    const src = `${window.location.protocol}//${this.appKeyValue}--${this.workspaceIdValue}.localhost${port}${path.startsWith("/") ? path : `/${path}`}`;
    if (this.element.src !== src) this.element.src = src;
    this.element.closest(".browser-shell")?.querySelector<HTMLAnchorElement>(".browser-open-external")?.setAttribute("href", src);
  }

  private isActivePane(): boolean {
    return this.element.closest(".tab-pane")?.classList.contains("active") ?? true;
  }
}

function startWorkspaceAppFrames(root: ParentNode, tabName: string): void {
  const pane = root.querySelector<HTMLElement>(`.tab-pane.active[data-tab-pane="${CSS.escape(tabName)}"]`);
  pane?.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]').forEach((frame) => {
    const controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { activate?: () => void } | null;
    controller?.activate?.();
  });
}

class WorkspaceTitleEditController extends Controller {
  static values = { cancelUrl: String };
  declare readonly element: HTMLFormElement;
  declare readonly cancelUrlValue: string;

  keydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    const frame = this.element.closest("turbo-frame");
    if (frame) frame.setAttribute("src", this.cancelUrlValue);
  }
}

const application = Application.start();
application.register("workspace-shell", WorkspaceShellController);
application.register("workspace-tabs", WorkspaceTabsController);
application.register("workspace-tab-close", WorkspaceTabCloseController);
application.register("workspace-groups", WorkspaceGroupsController);
application.register("workspace-residency", WorkspaceResidencyController);
application.register("terminal-pane", createTerminalPaneController(Controller));
application.register("agent-pane", createAgentPaneController(Controller));
application.register("agent-attachments", createAgentAttachmentsController(Controller));
application.register("agent-autosubmit", createAgentAutosubmitController(Controller));
application.register("agent-elapsed", createAgentElapsedController(Controller));
application.register("agent-notice", createAgentNoticeController(Controller));
application.register("agent-term", createAgentTermController(Controller));
application.register("browser-pane", createBrowserPaneController(Controller));
application.register("browser-address", createBrowserAddressController(Controller));
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("global-filter", GlobalFilterController);
application.register("workspace-list", WorkspaceListController);
application.register("workspace-title-edit", WorkspaceTitleEditController);
application.register("workspace-app-frame", WorkspaceAppFrameController);
