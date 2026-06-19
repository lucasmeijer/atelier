/// <reference lib="dom" />

import {
  createAgentAttachmentsController,
  createAgentAutosubmitController,
  createAgentCopyController,
  createAgentElapsedController,
  createAgentNoticeController,
  createAgentPaneController,
  createAgentProxyController,
  createAgentTermController,
  registerAgentStreamActions,
  startAgentTab,
  type AgentPaneControllerInstance,
} from "@atelier/agent/client";
import { createBrowserAddressController, createBrowserPaneController } from "@atelier/browser/client";
import { createProvisionTerminalController } from "@atelier/workspace/client";
import { createTerminalPaneController, initializeTerminalTheme, startTerminal, startTerminalTab } from "@atelier/workspace-terminal/client";

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

  connect(): void {
    this.setCollapsed(Boolean(this.savedState().collapsed));
  }

  toggle(): void {
    this.setCollapsed(!this.element.classList.contains("workspace-shell-collapsed"), { persist: true });
  }

  private setCollapsed(collapsed: boolean, options: { persist?: boolean } = {}): void {
    this.element.classList.toggle("workspace-shell-collapsed", collapsed);
    this.toggleTargets.forEach((button) => {
      button.textContent = collapsed ? "›" : "‹";
      button.setAttribute("aria-label", collapsed ? "Expand workspace list" : "Collapse workspace list");
      button.title = collapsed ? "Expand workspace list" : "Collapse workspace list";
    });
    if (options.persist) this.saveState({ ...this.savedState(), collapsed });
  }

  private savedState(): { collapsed?: boolean } {
    try {
      return JSON.parse(localStorage.getItem(this.storageKey) || "{}") as { collapsed?: boolean };
    } catch {
      return {};
    }
  }

  private saveState(state: { collapsed?: boolean }): void {
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
    });
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
    });
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

type WorkspaceShortcutCommand = { id: string; binding: string };

class AtelierShortcutsController extends Controller {
  declare readonly element: HTMLElement;

  connect(): void {
    // Listen at window capture so we get first chance at shortcuts that focused
    // Atelier-owned widgets (not iframes) might otherwise consume.
    window.addEventListener("keydown", this.keydown, true);
  }

  disconnect(): void {
    window.removeEventListener("keydown", this.keydown, true);
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.repeat || event.isComposing) return;
    if (!event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey) return;

    if (event.code === "BracketLeft" || event.key === "[" || event.key === "“") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.focusAdjacentGroup(-1);
      return;
    }

    if (event.code === "BracketRight" || event.key === "]" || event.key === "‘") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.focusAdjacentGroup(1);
      return;
    }

    if (event.code === "Backspace" || event.key === "Backspace") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.openOldestUnreadWorkspace();
      return;
    }

    const commandId = this.registeredShortcutCommandId(event);
    if (commandId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.executeActiveWorkspaceCommand(commandId);
    }
  };

  private registeredShortcutCommandId(event: KeyboardEvent): string | undefined {
    const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.active");
    const groups = resident?.querySelector<HTMLElement>(".workspace-groups[data-workspace-command-shortcuts]");
    if (!groups?.dataset.workspaceCommandShortcuts) return undefined;
    let shortcuts: unknown;
    try {
      shortcuts = JSON.parse(groups.dataset.workspaceCommandShortcuts);
    } catch {
      return undefined;
    }
    if (!Array.isArray(shortcuts)) return undefined;
    return shortcuts.find((shortcut): shortcut is WorkspaceShortcutCommand => {
      return typeof shortcut?.id === "string" && typeof shortcut?.binding === "string" && this.matchesBinding(event, shortcut.binding);
    })?.id;
  }

  private matchesBinding(event: KeyboardEvent, binding: string): boolean {
    const parts = new Set(binding.split("+").map((part) => part.trim()).filter(Boolean));
    const modifiers = new Set(["Meta", "Alt", "Control", "Shift"]);
    const code = [...parts].find((part) => !modifiers.has(part));
    return Boolean(code)
      && event.code === code
      && event.metaKey === parts.has("Meta")
      && event.altKey === parts.has("Alt")
      && event.ctrlKey === parts.has("Control")
      && event.shiftKey === parts.has("Shift");
  }

  private activeWorkspaceId(): string | undefined {
    const fromPath = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
    if (fromPath) return decodeURIComponent(fromPath);
    return residencyController()?.activeWorkspaceId();
  }

  private async openOldestUnreadWorkspace(): Promise<void> {
    const response = await fetch("/workspaces/open-oldest-unread", {
      method: "POST",
      headers: { "Accept": "text/vnd.turbo-stream.html" },
    });
    if (response.status === 204) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const location = response.headers.get("location");
    if (!location) return;
    const url = new URL(location, window.location.href);
    const workspaceId = decodeURIComponent(url.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1] ?? "");
    if (!workspaceId) return;
    const row = document.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"]`);
    const revealUnreadTab = row ? this.unreadTabs(row).find((tab) => tab.startsWith("agent:")) : undefined;
    workspaceListController()?.markActiveWorkspace(workspaceId);
    void residencyController()?.selectWorkspace(workspaceId, url.pathname, { revealUnreadTab });
  }

  private unreadTabs(row: HTMLElement): string[] {
    const raw = row.querySelector<HTMLElement>(".workspace-status")?.dataset.unreadTabs;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  }

  private async executeActiveWorkspaceCommand(commandId: string): Promise<void> {
    const workspaceId = this.activeWorkspaceId();
    if (!workspaceId) return;
    try {
      const response = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(commandId)}`, {
        method: "POST",
        headers: { "Accept": "text/vnd.turbo-stream.html" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (html) window.Turbo?.renderStreamMessage(html);
    } catch (error) {
      console.error("Could not execute workspace command", error);
    }
  }

  private focusAdjacentGroup(direction: -1 | 1): void {
    const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.active");
    if (!resident) return;
    const groups = [...resident.querySelectorAll<HTMLElement>(".workspace-group")];
    if (groups.length === 0) return;

    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = activeElement?.closest<HTMLElement>(".workspace-group");
    const currentIndex = current && groups.includes(current) ? groups.indexOf(current) : 0;
    const nextIndex = (currentIndex + direction + groups.length) % groups.length;
    this.focusGroup(groups[nextIndex] ?? groups[0]);
  }

  private focusGroup(group: HTMLElement | undefined): void {
    if (!group) return;
    const workspaceId = group.closest<HTMLElement>("[data-workspace-id]")?.dataset.workspaceId;
    const tabName = group.querySelector<HTMLElement>(".group-tab.active[data-tab]")?.dataset.tab;
    const pane = tabName
      ? group.querySelector<HTMLElement>(`.tab-pane.active[data-tab-pane="${CSS.escape(tabName)}"]`)
      : group.querySelector<HTMLElement>(".tab-pane.active[data-tab-pane]");

    if (workspaceId && tabName?.startsWith("terminal:")) {
      void startTerminal(workspaceId, tabName.slice("terminal:".length), { focus: true });
      return;
    }

    const agentInput = pane?.querySelector<HTMLTextAreaElement>(".agent-input");
    if (agentInput) {
      agentInput.focus();
      return;
    }

    const iframe = pane?.querySelector<HTMLIFrameElement>("iframe");
    if (iframe) {
      iframe.focus();
      return;
    }

    const focusable = pane?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
    if (focusable) {
      focusable.focus();
      return;
    }

    group.querySelector<HTMLButtonElement>(".group-tab.active .group-tab-label")?.focus();
  }
}

function focusDialogPromptEnd(dialog: ParentNode): void {
  const input = dialog.querySelector<HTMLTextAreaElement>("textarea");
  if (!input) return;
  requestAnimationFrame(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
}

class SubmitShortcutController extends Controller {
  declare readonly element: HTMLElement;

  keydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    const form = event.target instanceof HTMLElement ? event.target.closest<HTMLFormElement>("form") : null;
    if (!form || !this.element.contains(form)) return;
    event.preventDefault();
    const submitter = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
    form.requestSubmit(submitter ?? undefined);
  }
}

class ModalController extends Controller {
  static values = { autoShow: Boolean };
  declare readonly element: HTMLDialogElement;
  declare readonly autoShowValue: boolean;
  private readonly onClose = (): void => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    active?.blur();
  };

  connect(): void {
    this.element.addEventListener("close", this.onClose);
    if (this.autoShowValue && !this.element.open) {
      this.element.showModal();
      focusDialogPromptEnd(this.element);
    }
  }

  disconnect(): void {
    this.element.removeEventListener("close", this.onClose);
  }

  close(): void {
    this.element.close();
  }

  submitted(event: Event): void {
    const detail = (event as CustomEvent).detail as { success?: boolean } | undefined;
    if (detail?.success === false) return;
    this.element.close();
  }
}

class ModalOpenerController extends Controller {
  static values = { targetId: String };
  declare readonly element: HTMLElement;
  declare readonly targetIdValue: string;

  open(): void {
    const dialog = document.getElementById(this.targetIdValue) as HTMLDialogElement | null;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    this.element.blur();
    focusDialogPromptEnd(dialog);
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

  connect(): void {
    const workspaceId = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
    const activeResident = this.residentTargets.find((resident) => resident.classList.contains("active"))
      ?? (workspaceId ? this.residentTargets.find((resident) => resident.dataset.workspaceId === decodeURIComponent(workspaceId)) : undefined);
    if (activeResident) this.activateResident(activeResident);
  }

  async selectWorkspace(workspaceId: string, href: string, options: { revealUnreadTab?: string } = {}): Promise<void> {
    // Update the URL first: selection state is derived from it, and stream
    // broadcasts arriving while the resident loads must not flip selection back.
    const seq = ++this.selectionSeq;
    history.pushState({}, "", href);
    const existing = this.residentTargets.find((resident) => resident.dataset.workspaceId === workspaceId);
    if (existing) {
      this.activateResident(existing, options);
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
    if (seq === this.selectionSeq) this.activateResident(resident, options);
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    const html = await fetch(url, { headers: { "Accept": "text/html" }, cache: "no-store", signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") throw new Error("Timed out loading workspace");
      throw error;
    }).finally(() => window.clearTimeout(timeout));
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const resident = template.content.firstElementChild;
    if (!(resident instanceof HTMLElement)) throw new Error("Workspace response did not include a resident view");
    return resident;
  }

  private activateResident(resident: HTMLElement, options: { revealUnreadTab?: string } = {}): void {
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    this.residentTargets.forEach((candidate) => candidate.classList.toggle("active", candidate === resident));
    resident.dataset.lastActivatedAt = String(Date.now());
    const revealTab = options.revealUnreadTab;
    const tabs = revealTab
      ? this.tabbarForTab(resident, revealTab) ?? resident.querySelector<HTMLElement>('[data-controller~="workspace-tabs"]')
      : resident.querySelector<HTMLElement>('[data-controller~="workspace-tabs"]');
    const controller = tabs ? application.getControllerForElementAndIdentifier(tabs, "workspace-tabs") as WorkspaceTabsController | null : null;
    const activeTab = revealTab ?? tabs?.querySelector<HTMLElement>(".group-tab.active[data-tab]")?.dataset.tab;
    if (activeTab) controller?.activateTab(activeTab, { persist: false });
    const workspaceId = resident.dataset.workspaceId;
    if (workspaceId) void this.clearWorkspaceUnread(workspaceId);
    if (revealTab?.startsWith("agent:")) this.revealLatestAssistant(resident, revealTab);
  }

  private tabbarForTab(resident: HTMLElement, tabName: string): HTMLElement | null {
    const tab = resident.querySelector<HTMLElement>(`.group-tab[data-tab="${CSS.escape(tabName)}"]`);
    return tab?.closest<HTMLElement>('[data-controller~="workspace-tabs"]') ?? null;
  }

  private revealLatestAssistant(resident: HTMLElement, tabName: string): void {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const pane = resident.querySelector<HTMLElement>(`.tab-pane.active[data-tab-pane="${CSS.escape(tabName)}"]`);
      const agentPane = pane?.querySelector<HTMLElement>('[data-controller~="agent-pane"]');
      const controller = agentPane ? application.getControllerForElementAndIdentifier(agentPane, "agent-pane") as AgentPaneControllerInstance | null : null;
      controller?.revealLatestAssistant();
    }));
  }

  private async clearWorkspaceUnread(workspaceId: string): Promise<void> {
    const html = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/unread/clear`, {
      method: "POST",
      headers: { "Accept": "text/vnd.turbo-stream.html" },
    }).then((response) => response.text());
    if (html) window.Turbo?.renderStreamMessage(html);
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

function workspaceListController(): WorkspaceListController | null {
  const list = document.querySelector<HTMLElement>('[data-controller~="workspace-list"]');
  return list ? application.getControllerForElementAndIdentifier(list, "workspace-list") as WorkspaceListController | null : null;
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
    if (row.classList.contains("pending-delete") || row.dataset.phase === "checking_delete" || row.dataset.phase === "deleting") {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const workspaceId = row.dataset.workspaceId;
    const revealUnreadTab = this.unreadTabs(row).find((tab) => tab.startsWith("agent:"));
    if (workspaceId) void residencyController()?.selectWorkspace(workspaceId, link.href, { revealUnreadTab });
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

  markActiveWorkspace(workspaceId: string): void {
    this.markActive(workspaceId);
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

  private unreadTabs(row: HTMLElement): string[] {
    const raw = row.querySelector<HTMLElement>(".workspace-status")?.dataset.unreadTabs;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
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

class WorkspaceAppFrameController extends Controller {
  static values = { workspaceId: String, appKey: String, initialPath: String };
  declare readonly element: HTMLIFrameElement;
  declare readonly workspaceIdValue: string;
  declare readonly appKeyValue: string;
  declare readonly initialPathValue: string;
  declare readonly hasInitialPathValue: boolean;

  connect(): void {
    document.addEventListener("atelier:theme-change", this.themeChanged);
    if (this.isActivePane()) this.load();
  }

  disconnect(): void {
    document.removeEventListener("atelier:theme-change", this.themeChanged);
  }

  activate(): void {
    this.load();
  }

  load(): void {
    const src = this.frameSrc();
    if (this.element.src !== src) this.element.src = src;
    this.element.closest(".browser-shell")?.querySelector<HTMLAnchorElement>(".browser-open-external")?.setAttribute("href", src);
  }

  private frameSrc(): string {
    const port = window.location.port ? `:${window.location.port}` : "";
    const path = this.hasInitialPathValue && this.initialPathValue ? this.initialPathValue : "/";
    const hostSuffix = window.location.hostname === "localhost" ? "localhost" : window.location.hostname;
    const url = new URL(`${window.location.protocol}//${this.appKeyValue}--${this.workspaceIdValue}.${hostSuffix}${port}${path.startsWith("/") ? path : `/${path}`}`);
    if (this.appKeyValue === "vscode") addAtelierThemeParams(url);
    return url.toString();
  }

  private themeChanged = (): void => {
    if (this.appKeyValue === "vscode" && this.element.src) this.load();
  };

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

function currentAtelierTheme(): string {
  const active = document.documentElement.dataset.theme;
  if (active) return active;
  try {
    return localStorage.getItem("atelier.theme") || "cappuccino";
  } catch {
    return "cappuccino";
  }
}

function cssVariable(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function addAtelierThemeParams(url: URL): void {
  url.searchParams.set("atelierTheme", currentAtelierTheme());
  url.searchParams.set("atelierBg", cssVariable("--bg"));
  url.searchParams.set("atelierPanel", cssVariable("--panel"));
  url.searchParams.set("atelierElev", cssVariable("--elev"));
  url.searchParams.set("atelierText", cssVariable("--text"));
  url.searchParams.set("atelierLine", cssVariable("--line"));
  url.searchParams.set("atelierAccent", cssVariable("--accent"));
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

class AutoScrollController extends Controller {
  declare readonly element: HTMLElement;

  connect(): void {
    requestAnimationFrame(() => {
      this.element.scrollTop = this.element.scrollHeight;
    });
  }
}

class ThemeSelectController extends Controller {
  declare readonly element: HTMLSelectElement;
  private readonly storageKey = "atelier.theme";

  connect(): void {
    const saved = this.loadTheme();
    if (saved) this.element.value = saved;
    this.apply(this.element.value || "cappuccino");
    this.element.addEventListener("change", this.changed);
  }

  disconnect(): void {
    this.element.removeEventListener("change", this.changed);
  }

  private changed = (): void => {
    localStorage.setItem(this.storageKey, this.element.value);
    this.apply(this.element.value);
  };

  private loadTheme(): string | undefined {
    try { return localStorage.getItem(this.storageKey) || undefined; } catch { return undefined; }
  }

  private apply(theme: string): void {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll<HTMLSelectElement>('select[data-controller~="theme-select"]').forEach((select) => {
      if (select !== this.element) select.value = theme;
    });
    document.dispatchEvent(new CustomEvent("atelier:theme-change", { detail: { theme } }));
  }
}

class OAuthFlowController extends Controller {
  static values = { statusUrl: String, active: Boolean };
  declare readonly statusUrlValue: string;
  declare readonly activeValue: boolean;
  private timer: number | undefined;

  connect(): void {
    if (!this.activeValue || !this.statusUrlValue) return;
    this.timer = window.setInterval(() => void this.poll(), 1500);
  }

  disconnect(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    const response = await fetch(this.statusUrlValue, {
      method: "POST",
      headers: { Accept: "text/vnd.turbo-stream.html" },
    });
    if (!response.ok) return;
    const html = await response.text();
    window.Turbo?.renderStreamMessage(html);
  }
}

class ProviderListController extends Controller {
  static values = { label: String, openLabel: String };
  declare readonly element: HTMLButtonElement;
  declare readonly labelValue: string;
  declare readonly openLabelValue: string;
  private open = false;

  connect(): void {
    this.sync();
  }

  toggle(): void {
    this.open = !this.open;
    this.sync();
  }

  private sync(): void {
    const scope = this.element.closest<HTMLElement>("[data-provider-list-scope]") ?? document.body;
    scope.querySelectorAll<HTMLElement>('[data-provider-extra="true"]').forEach((row) => row.classList.toggle("hidden", !this.open));
    this.element.textContent = this.open ? (this.openLabelValue || "Show fewer providers") : (this.labelValue || "Show more providers");
  }
}

class ModelAddMenuController extends Controller {
  static targets = ["filter", "option", "options"];
  declare readonly element: HTMLDetailsElement;
  declare readonly filterTarget: HTMLInputElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly hasFilterTarget: boolean;

  connect(): void {
    this.element.addEventListener("toggle", this.focusFilter);
  }

  disconnect(): void {
    this.element.removeEventListener("toggle", this.focusFilter);
  }

  close(event?: Event): void {
    event?.preventDefault();
    this.element.open = false;
  }

  filter(): void {
    const query = (this.hasFilterTarget ? this.filterTarget.value : "").trim().toLowerCase();
    this.optionTargets.forEach((option) => {
      option.hidden = query.length > 0 && !(option.dataset.searchText ?? "").includes(query);
    });
  }

  private focusFilter = (): void => {
    if (this.element.open && this.hasFilterTarget) requestAnimationFrame(() => this.filterTarget.focus());
  };
}

class ModelPickerController extends Controller {
  declare readonly element: HTMLElement;
  private dragged?: HTMLElement;

  dragStart(event: DragEvent): void {
    const row = (event.currentTarget instanceof HTMLElement ? event.currentTarget : null)?.closest<HTMLElement>(".settings-model-row");
    if (!row) return;
    this.dragged = row;
    row.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", row.dataset.modelPickerModelValue ?? "");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  dragOver(event: DragEvent): void {
    if (!this.dragged) return;
    event.preventDefault();
    const row = (event.target instanceof HTMLElement ? event.target : null)?.closest<HTMLElement>(".settings-model-row");
    this.element.querySelectorAll(".settings-model-row").forEach((candidate) => candidate.classList.remove("drop-before", "drop-after"));
    if (!row || row === this.dragged) return;
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    row.insertAdjacentElement(after ? "afterend" : "beforebegin", this.dragged);
    this.dragged.classList.add(after ? "drop-after" : "drop-before");
  }

  async drop(event: DragEvent): Promise<void> {
    if (!this.dragged) return;
    event.preventDefault();
    this.clearDropMarkers();
    await this.persistOrder();
  }

  dragEnd(): void {
    this.dragged?.classList.remove("dragging");
    this.dragged = undefined;
    this.clearDropMarkers();
  }

  private clearDropMarkers(): void {
    this.element.querySelectorAll(".settings-model-row").forEach((candidate) => candidate.classList.remove("drop-before", "drop-after"));
  }

  private async persistOrder(): Promise<void> {
    const models = Array.from(this.element.querySelectorAll<HTMLElement>(".settings-model-row"))
      .map((row) => row.dataset.modelPickerModelValue)
      .filter((value): value is string => Boolean(value));
    const body = new URLSearchParams();
    models.forEach((model) => body.append("model", model));
    const html = await fetch("/settings/models/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/vnd.turbo-stream.html" },
      body,
    }).then((response) => response.text()).catch(() => "");
    if (html) window.Turbo?.renderStreamMessage(html);
  }

}

class OnboardingController extends Controller {
  static targets = ["pane", "dot", "continue"];
  declare readonly paneTargets: HTMLElement[];
  declare readonly dotTargets: HTMLElement[];
  declare readonly continueTarget: HTMLButtonElement;
  declare readonly hasContinueTarget: boolean;
  private index = 0;

  connect(): void {
    this.show(0);
  }

  next(): void {
    if (this.index >= this.paneTargets.length - 1) {
      (this.element as HTMLDialogElement).close?.();
      return;
    }
    this.show(this.index + 1);
  }

  prev(): void {
    this.show(Math.max(0, this.index - 1));
  }

  private show(index: number): void {
    this.index = index;
    this.paneTargets.forEach((pane, paneIndex) => pane.classList.toggle("active", paneIndex === index));
    this.dotTargets.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === index));
    const current = this.paneTargets[index];
    const complete = current?.dataset.onboardingComplete === "true";
    if (this.hasContinueTarget) this.continueTarget.classList.toggle("primary", complete);
  }
}

class ClipboardController extends Controller {
  static targets = ["source"];
  declare readonly sourceTarget: HTMLElement;
  declare readonly hasSourceTarget: boolean;

  async copy(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.hasSourceTarget) return;
    const text = this.sourceTarget.textContent?.trim() ?? "";
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : undefined;
    if (!button) return;
    const original = button.textContent ?? "Copy to clipboard";
    button.textContent = button.classList.contains("icon") ? "✓" : "Copied";
    window.setTimeout(() => { button.textContent = original; }, 1200);
  }
}

class AgentSelectMenuController extends Controller {
  declare readonly element: HTMLSelectElement;
  private button?: HTMLButtonElement;
  private menu?: HTMLDivElement;
  private observer?: MutationObserver;

  connect(): void {
    if (this.element.dataset.agentSelectEnhanced === "true") return;
    this.element.dataset.agentSelectEnhanced = "true";
    this.element.classList.add("agent-sel-native");
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "agent-sel-button";
    this.button.addEventListener("click", this.toggle);
    this.menu = document.createElement("div");
    this.menu.className = "agent-sel-menu hidden";
    this.element.after(this.button, this.menu);
    this.element.addEventListener("change", this.sync);
    document.addEventListener("click", this.closeFromOutside);
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["selected"] });
    this.sync();
  }

  disconnect(): void {
    this.button?.removeEventListener("click", this.toggle);
    this.element.removeEventListener("change", this.sync);
    document.removeEventListener("click", this.closeFromOutside);
    this.observer?.disconnect();
    this.button?.remove();
    this.menu?.remove();
    this.element.classList.remove("agent-sel-native");
    delete this.element.dataset.agentSelectEnhanced;
  }

  private sync = (): void => {
    if (!this.button || !this.menu) return;
    const selected = this.element.selectedOptions[0]?.textContent?.trim() || this.element.value;
    this.button.textContent = selected;
    this.menu.innerHTML = "";
    Array.from(this.element.options).forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `agent-sel-option${option.selected ? " selected" : ""}`;
      const label = document.createElement("span");
      label.textContent = option.textContent ?? option.value;
      item.appendChild(label);
      if (option.selected) {
        const check = document.createElement("b");
        check.textContent = "✓";
        item.appendChild(check);
      }
      item.addEventListener("click", () => {
        this.element.value = option.value;
        this.element.dispatchEvent(new Event("change", { bubbles: true }));
        this.close();
      });
      this.menu?.appendChild(item);
    });
  };

  private toggle = (event: MouseEvent): void => {
    event.stopPropagation();
    document.querySelectorAll(".agent-sel-menu").forEach((menu) => {
      if (menu !== this.menu) menu.classList.add("hidden");
    });
    if (!this.menu || !this.button) return;
    const opening = this.menu.classList.contains("hidden");
    this.menu.classList.toggle("hidden", !opening);
    if (opening) this.positionMenu();
  };

  private positionMenu(): void {
    if (!this.menu || !this.button) return;
    const rect = this.button.getBoundingClientRect();
    const width = Math.max(184, Math.min(262, rect.width + 120));
    this.menu.style.width = `${width}px`;
    this.menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    this.menu.style.top = `${Math.max(8, rect.top - this.menu.getBoundingClientRect().height - 8)}px`;
  }

  private closeFromOutside = (event: MouseEvent): void => {
    const target = event.target instanceof Node ? event.target : null;
    if (target && (this.menu?.contains(target) || this.button?.contains(target))) return;
    this.close();
  };

  private close(): void {
    this.menu?.classList.add("hidden");
  }
}

const application = Application.start();
application.register("workspace-shell", WorkspaceShellController);
application.register("workspace-tabs", WorkspaceTabsController);
application.register("workspace-tab-close", WorkspaceTabCloseController);
application.register("workspace-groups", WorkspaceGroupsController);
application.register("workspace-residency", WorkspaceResidencyController);
application.register("atelier-shortcuts", AtelierShortcutsController);
application.register("submit-shortcut", SubmitShortcutController);
application.register("terminal-pane", createTerminalPaneController(Controller));
application.register("agent-pane", createAgentPaneController(Controller));
application.register("agent-attachments", createAgentAttachmentsController(Controller));
application.register("agent-autosubmit", createAgentAutosubmitController(Controller));
application.register("agent-copy", createAgentCopyController(Controller));
application.register("agent-elapsed", createAgentElapsedController(Controller));
application.register("agent-notice", createAgentNoticeController(Controller));
application.register("agent-proxy", createAgentProxyController(Controller));
application.register("agent-term", createAgentTermController(Controller));
application.register("browser-pane", createBrowserPaneController(Controller));
application.register("browser-address", createBrowserAddressController(Controller));
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("workspace-list", WorkspaceListController);
application.register("workspace-title-edit", WorkspaceTitleEditController);
application.register("provision-terminal", createProvisionTerminalController(Controller));
application.register("auto-scroll", AutoScrollController);
application.register("workspace-app-frame", WorkspaceAppFrameController);
application.register("theme-select", ThemeSelectController);
application.register("oauth-flow", OAuthFlowController);
application.register("provider-list", ProviderListController);
application.register("model-add-menu", ModelAddMenuController);
application.register("model-picker", ModelPickerController);
application.register("onboarding", OnboardingController);
application.register("clipboard", ClipboardController);
application.register("agent-select-menu", AgentSelectMenuController);
