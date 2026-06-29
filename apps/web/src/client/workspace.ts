/// <reference lib="dom" />

import type {
  WorkspaceClientActivateTabContext,
  WorkspaceClientFocusContext,
  WorkspaceClientHooks,
  WorkspaceClientWorkspaceAppFrameContext,
} from "@atelier/shared";
import { createProvisionTerminalController } from "@atelier/workspace/client";
import { workspaceClientModules } from "./workspace-client-modules.generated.ts";

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

class WorkspaceClientHookRegistry implements WorkspaceClientHooks {
  private readonly activateTabHandlers: Array<(context: WorkspaceClientActivateTabContext) => void> = [];
  private readonly focusGroupHandlers: Array<(context: WorkspaceClientFocusContext) => boolean | void | Promise<boolean | void>> = [];
  private readonly revealTabHandlers: Array<(context: WorkspaceClientActivateTabContext) => void> = [];
  private readonly chooseUnreadTabHandlers: Array<(tabs: string[]) => string | undefined> = [];
  private readonly workspaceCommandHandlers: Array<(commandId: string) => boolean | void | Promise<boolean | void>> = [];
  private readonly workspaceAppFrameUrlHandlers: Array<(context: WorkspaceClientWorkspaceAppFrameContext) => void> = [];
  private readonly workspaceAppFrameRefreshHandlers: Array<(context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void> = [];

  onActivateTab(handler: (context: WorkspaceClientActivateTabContext) => void): void { this.activateTabHandlers.push(handler); }
  onFocusGroup(handler: (context: WorkspaceClientFocusContext) => boolean | void | Promise<boolean | void>): void { this.focusGroupHandlers.push(handler); }
  onRevealTab(handler: (context: WorkspaceClientActivateTabContext) => void): void { this.revealTabHandlers.push(handler); }
  onChooseUnreadTab(handler: (tabs: string[]) => string | undefined): void { this.chooseUnreadTabHandlers.push(handler); }
  onWorkspaceCommand(handler: (commandId: string) => boolean | void | Promise<boolean | void>): void { this.workspaceCommandHandlers.push(handler); }
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void { this.workspaceAppFrameUrlHandlers.push(handler); }
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void { this.workspaceAppFrameRefreshHandlers.push(handler); }

  activateTab(context: WorkspaceClientActivateTabContext): void {
    this.activateTabHandlers.forEach((handler) => handler(context));
  }

  async focusGroup(context: WorkspaceClientFocusContext): Promise<boolean> {
    for (const handler of this.focusGroupHandlers) {
      if (await handler(context)) return true;
    }
    return false;
  }

  revealTab(context: WorkspaceClientActivateTabContext): void {
    this.revealTabHandlers.forEach((handler) => handler(context));
  }

  chooseUnreadTab(tabs: string[]): string | undefined {
    for (const handler of this.chooseUnreadTabHandlers) {
      const tab = handler(tabs);
      if (tab) return tab;
    }
    return tabs[0];
  }

  async handleWorkspaceCommand(commandId: string): Promise<boolean> {
    for (const handler of this.workspaceCommandHandlers) {
      if (await handler(commandId)) return true;
    }
    return false;
  }

  workspaceAppFrameUrl(context: WorkspaceClientWorkspaceAppFrameContext): void {
    this.workspaceAppFrameUrlHandlers.forEach((handler) => handler(context));
  }

  workspaceAppFrameRefresh(context: { appKey: string; frame: HTMLIFrameElement; load(): void }): void {
    this.workspaceAppFrameRefreshHandlers.forEach((handler) => handler(context));
  }
}

const clientHooks = new WorkspaceClientHookRegistry();

class WorkspaceShellController extends Controller {
  static targets = ["sidebar", "toggle"];
  declare readonly element: HTMLElement;
  declare readonly sidebarTarget: HTMLElement;
  declare readonly hasSidebarTarget: boolean;
  declare readonly toggleTargets: HTMLButtonElement[];
  private readonly storageKey = "atelier.workspaceSidebar";
  private resizeStart: { x: number; width: number } | undefined;

  connect(): void {
    const state = this.savedState();
    this.element.style.setProperty("--workspace-sidebar-width", `${state.width ?? 250}px`);
    this.setCollapsed(Boolean(state.collapsed));
  }

  toggle(): void {
    this.setCollapsed(!this.element.classList.contains("workspace-shell-collapsed"), { persist: true });
  }

  startResize(event: PointerEvent): void {
    this.setCollapsed(false, { persist: true });
    this.resizeStart = { x: event.clientX, width: this.sidebarTarget.getBoundingClientRect().width };
    window.addEventListener("pointermove", this.resizeMove);
    window.addEventListener("pointerup", this.resizeEnd, { once: true });
  }

  private readonly resizeMove = (event: PointerEvent): void => {
    const width = Math.round(Math.min(520, Math.max(180, this.resizeStart!.width + event.clientX - this.resizeStart!.x)));
    this.element.style.setProperty("--workspace-sidebar-width", `${width}px`);
  };

  private readonly resizeEnd = (): void => {
    window.removeEventListener("pointermove", this.resizeMove);
    const width = Math.round(this.sidebarTarget.getBoundingClientRect().width);
    this.saveState({ ...this.savedState(), width });
    this.resizeStart = undefined;
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

  private savedState(): { collapsed?: boolean; width?: number } {
    return JSON.parse(localStorage.getItem(this.storageKey) || "{}") as { collapsed?: boolean; width?: number };
  }

  private saveState(state: { collapsed?: boolean; width?: number }): void {
    localStorage.setItem(this.storageKey, JSON.stringify(state));
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
    const activeTab = this.element.querySelector<HTMLElement>(".group-tab.active[data-tab]")?.dataset.tab;
    if (activeTab) this.activateTab(activeTab, { persist: false });
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

    clientHooks.activateTab({ workspaceId: this.workspaceIdValue, tabKey: tabName, group: this.group, application });
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

type CommandRegistration = {
  id: string;
  label: string;
  description?: string;
  scope: "global" | "workspace" | "group" | "tab";
  binding?: string;
  run: () => void | Promise<void>;
};
type WorkspaceCommandRegistration = Omit<CommandRegistration, "run">;

class AtelierShortcutsController extends Controller {
  declare readonly element: HTMLElement;
  private readonly commands = new Map<string, CommandRegistration>();
  private shortcutOverlayTimer: ReturnType<typeof setTimeout> | undefined;
  private shortcutOverlay: HTMLElement | undefined;

  connect(): void {
    this.registerBuiltinCommands();
    // Listen at window capture so we get first chance at shortcuts that focused
    // Atelier-owned widgets (not iframes) might otherwise consume.
    window.addEventListener("keydown", this.keydown, true);
    window.addEventListener("keyup", this.keyup, true);
    window.addEventListener("blur", this.hideShortcutOverlay);
  }

  disconnect(): void {
    window.removeEventListener("keydown", this.keydown, true);
    window.removeEventListener("keyup", this.keyup, true);
    window.removeEventListener("blur", this.hideShortcutOverlay);
    this.hideShortcutOverlay();
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.repeat || event.isComposing) return;
    if (!event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey) return;

    if (event.key === "Meta" || event.key === "Alt") {
      this.scheduleShortcutOverlay();
      return;
    }

    this.hideShortcutOverlay();
    const command = this.currentCommands().find((candidate) => candidate.binding && this.matchesBinding(event, candidate.binding));
    if (!command) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void command.run();
  };

  private readonly keyup = (event: KeyboardEvent): void => {
    if (!event.metaKey || !event.altKey) this.hideShortcutOverlay();
  };

  private registerCommand(command: CommandRegistration): void {
    this.commands.set(command.id, command);
  }

  private registerBuiltinCommands(): void {
    this.registerCommand({
      id: "workspace.open-previous",
      label: "Open previous workspace",
      scope: "global",
      binding: "Meta+Alt+Comma",
      run: () => this.openAdjacentWorkspace(-1),
    });
    this.registerCommand({
      id: "workspace.open-next",
      label: "Open next workspace",
      scope: "global",
      binding: "Meta+Alt+Period",
      run: () => this.openAdjacentWorkspace(1),
    });
    this.registerCommand({
      id: "workspace.open-oldest-unread",
      label: "Open oldest unread workspace",
      scope: "global",
      binding: "Meta+Alt+Slash",
      run: () => this.openOldestUnreadWorkspace(),
    });
    this.registerCommand({
      id: "agent.launch-empty-workspace",
      label: "New Empty Agent Workspace",
      scope: "global",
      binding: "Meta+Alt+Semicolon",
      run: () => this.openDialogPrompt("agent_launch_empty_workspace_modal"),
    });
  }

  private currentCommands(): CommandRegistration[] {
    return [
      ...this.commands.values(),
      ...this.workspaceCommands().map((command) => ({
        ...command,
        run: () => this.executeActiveWorkspaceCommand(command.id),
      })),
    ];
  }

  private workspaceCommands(): WorkspaceCommandRegistration[] {
    const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.active");
    const groups = resident?.querySelector<HTMLElement>(".workspace-groups[data-workspace-commands]");
    return groups ? JSON.parse(groups.dataset.workspaceCommands!) as WorkspaceCommandRegistration[] : [];
  }

  private scheduleShortcutOverlay(): void {
    if (this.shortcutOverlay || this.shortcutOverlayTimer) return;
    this.shortcutOverlayTimer = setTimeout(() => {
      this.shortcutOverlayTimer = undefined;
      this.showShortcutOverlay();
    }, 2000);
  }

  private readonly hideShortcutOverlay = (): void => {
    if (this.shortcutOverlayTimer) clearTimeout(this.shortcutOverlayTimer);
    this.shortcutOverlayTimer = undefined;
    this.shortcutOverlay?.remove();
    this.shortcutOverlay = undefined;
  };

  private showShortcutOverlay(): void {
    const commands = this.currentCommands()
      .filter((command): command is CommandRegistration & { binding: string } => Boolean(command.binding))
      .sort((a, b) => a.label.localeCompare(b.label));

    const overlay = document.createElement("aside");
    overlay.className = "shortcut-overlay";
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");

    const title = document.createElement("div");
    title.className = "shortcut-overlay-title";
    title.textContent = "Keyboard shortcuts";
    overlay.append(title);

    const list = document.createElement("dl");
    list.className = "shortcut-overlay-list";
    for (const command of commands) {
      const label = document.createElement("dt");
      label.textContent = command.label;
      const binding = document.createElement("dd");
      binding.textContent = this.formatBinding(command.binding);
      list.append(label, binding);
    }
    overlay.append(list);

    document.body.append(overlay);
    this.shortcutOverlay = overlay;
  }

  private formatBinding(binding: string): string {
    return binding.split("+").map((part) => {
      switch (part) {
        case "Meta": return "⌘";
        case "Alt": return "⌥";
        case "Control": return "⌃";
        case "Shift": return "⇧";
        case "Comma": return ",";
        case "Period": return ".";
        case "Slash": return "/";
        case "Quote": return "'";
        case "Semicolon": return ";";
        default: return part.replace(/^Key/, "");
      }
    }).join("");
  }

  private matchesBinding(event: KeyboardEvent, binding: string): boolean {
    const parts = new Set(binding.split("+").map((part) => part.trim()).filter(Boolean));
    const modifiers = new Set(["Meta", "Alt", "Control", "Shift"]);
    const code = [...parts].find((part) => !modifiers.has(part));
    if (!code) return false;
    return this.matchesShortcutKey(event, code)
      && event.metaKey === parts.has("Meta")
      && event.altKey === parts.has("Alt")
      && event.ctrlKey === parts.has("Control")
      && event.shiftKey === parts.has("Shift");
  }

  private matchesShortcutKey(event: KeyboardEvent, code: string): boolean {
    if (event.code === code) return true;
    switch (code) {
      case "Comma": return event.key === ",";
      case "Period": return event.key === ".";
      case "Slash": return event.key === "/" || event.key === "?";
      case "Semicolon": return event.key === ";" || event.key === ":";
      default: return false;
    }
  }

  private openDialogPrompt(id: string): void {
    const dialog = document.getElementById(id) as HTMLDialogElement | null;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusDialogPromptEnd(dialog);
  }

  private activeWorkspaceId(): string | undefined {
    return document.querySelector<HTMLElement>(".workspace-row.active[data-workspace-id]")?.dataset.workspaceId
      ?? residencyController()?.activeWorkspaceId();
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
    const revealUnreadTab = row ? clientHooks.chooseUnreadTab(this.unreadTabs(row)) : undefined;
    workspaceListController()?.markActiveWorkspace(workspaceId);
    void residencyController()?.selectWorkspace(workspaceId, url.pathname, { revealUnreadTab });
  }

  private unreadTabs(row: HTMLElement): string[] {
    const raw = row.querySelector<HTMLElement>(".workspace-status")?.dataset.unreadTabs;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  }

  private async openAdjacentWorkspace(direction: -1 | 1): Promise<void> {
    const rows = [...document.querySelectorAll<HTMLElement>(".workspace-row[data-workspace-id]")]
      .filter((row) => !row.classList.contains("pending-delete") && row.dataset.phase !== "checking_delete" && row.dataset.phase !== "deleting");
    if (rows.length === 0) return;
    const currentWorkspaceId = this.activeWorkspaceId();
    const currentIndex = currentWorkspaceId ? rows.findIndex((row) => row.dataset.workspaceId === currentWorkspaceId) : -1;
    const row = this.adjacentUnparkedWorkspaceRow(rows, currentIndex, direction);
    const workspaceId = row?.dataset.workspaceId;
    const href = row?.querySelector<HTMLAnchorElement>("a.row-main")?.href;
    if (!row || !workspaceId || !href) return;
    const revealUnreadTab = clientHooks.chooseUnreadTab(this.unreadTabs(row));
    workspaceListController()?.markActiveWorkspace(workspaceId);
    await residencyController()?.selectWorkspace(workspaceId, href, { revealUnreadTab });
  }

  private adjacentUnparkedWorkspaceRow(rows: HTMLElement[], currentIndex: number, direction: -1 | 1): HTMLElement | undefined {
    const selectable = (row: HTMLElement): boolean => row.dataset.parked !== "true" && !row.classList.contains("parked");
    if (currentIndex < 0) return direction > 0 ? rows.find(selectable) : rows.findLast(selectable);
    for (let offset = 1; offset < rows.length; offset += 1) {
      const row = rows[(currentIndex + (direction * offset) + rows.length) % rows.length];
      if (row && selectable(row)) return row;
    }
    return undefined;
  }

  private async executeActiveWorkspaceCommand(commandId: string): Promise<void> {
    const workspaceId = this.activeWorkspaceId();
    if (!workspaceId) return;
    if (await clientHooks.handleWorkspaceCommand(commandId)) return;
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
    if (workspaceId) void this.activateWorkspace(workspaceId);
    const group = tabs?.closest(".workspace-group") ?? resident;
    if (revealTab && workspaceId) clientHooks.revealTab({ workspaceId, tabKey: revealTab, group, application });
  }

  private tabbarForTab(resident: HTMLElement, tabName: string): HTMLElement | null {
    const tab = resident.querySelector<HTMLElement>(`.group-tab[data-tab="${CSS.escape(tabName)}"]`);
    return tab?.closest<HTMLElement>('[data-controller~="workspace-tabs"]') ?? null;
  }

  private async activateWorkspace(workspaceId: string): Promise<void> {
    const html = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/activate`, {
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
    const revealUnreadTab = clientHooks.chooseUnreadTab(this.unreadTabs(row));
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
    const link = row?.querySelector<HTMLAnchorElement>("a.row-main");
    if (!row || !link) return;
    if (row.classList.contains("pending-delete") || row.dataset.phase === "checking_delete" || row.dataset.phase === "deleting") return;
    const workspaceId = row.dataset.workspaceId;
    const revealUnreadTab = clientHooks.chooseUnreadTab(this.unreadTabs(row));
    if (workspaceId) void residencyController()?.selectWorkspace(workspaceId, link.href, { revealUnreadTab });
    this.markActive(workspaceId);
  }

  markActiveWorkspace(workspaceId: string): void {
    this.markActive(workspaceId);
  }

  parkToggled(event: Event): void {
    const detail = (event as CustomEvent<{ success?: boolean }>).detail;
    if (detail && detail.success === false) return;
    const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
    if (!form || !new URL(form.action, window.location.href).pathname.endsWith("/unpark")) return;
    const row = form.closest<HTMLElement>(".workspace-row");
    const workspaceId = row?.dataset.workspaceId;
    const href = row?.querySelector<HTMLAnchorElement>("a.row-main")?.href;
    if (!workspaceId || !href) return;
    this.markActive(workspaceId);
    void residencyController()?.selectWorkspace(workspaceId, href);
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
  }

  private frameSrc(): string {
    const path = this.hasInitialPathValue && this.initialPathValue ? this.initialPathValue : "/";
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/apps/${encodeURIComponent(this.appKeyValue)}${normalizedPath}`, window.location.href);
    clientHooks.workspaceAppFrameUrl({ appKey: this.appKeyValue, url, frame: this.element });
    return url.toString();
  }

  private themeChanged = (): void => {
    clientHooks.workspaceAppFrameRefresh({ appKey: this.appKeyValue, frame: this.element, load: () => this.load() });
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
    const theme = this.loadTheme() ?? document.documentElement.dataset.theme ?? "nord";
    this.element.value = theme;
    this.apply(theme);
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
  static values = { statusUrl: String, active: Boolean, pollMs: Number };
  declare readonly statusUrlValue: string;
  declare readonly activeValue: boolean;
  declare readonly pollMsValue: number;
  declare readonly hasPollMsValue: boolean;
  private timer: number | undefined;
  private polling = false;

  connect(): void {
    if (!this.activeValue || !this.statusUrlValue) return;
    this.timer = window.setInterval(() => void this.poll(), this.hasPollMsValue ? this.pollMsValue : 3000);
    window.addEventListener("focus", this.pollSoon);
    document.addEventListener("visibilitychange", this.pollIfVisible);
  }

  disconnect(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    window.removeEventListener("focus", this.pollSoon);
    document.removeEventListener("visibilitychange", this.pollIfVisible);
  }

  private pollSoon = (): void => {
    window.setTimeout(() => void this.poll(), 100);
  };

  private pollIfVisible = (): void => {
    if (document.visibilityState === "visible") void this.poll();
  };

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const response = await fetch(this.statusUrlValue, {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "text/vnd.turbo-stream.html" },
    }).catch(() => undefined);
    this.polling = false;
    if (!response?.ok) return;
    const manualTroubleOpen = this.element.querySelector<HTMLDetailsElement>(".settings-oauth-manual")?.open ?? false;
    const html = await response.text();
    window.Turbo?.renderStreamMessage(html);
    if (manualTroubleOpen) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLDetailsElement>("#settings_flow_dialog .settings-oauth-manual")?.setAttribute("open", "");
      });
    }
  }
}

class SettingsCheckboxController extends Controller {
  declare readonly element: HTMLFormElement;

  submit(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  async save(): Promise<void> {
    const response = await fetch(this.element.action, {
      method: this.element.method || "POST",
      body: new FormData(this.element),
      headers: { Accept: "text/vnd.turbo-stream.html" },
    });
    window.Turbo?.renderStreamMessage(await response.text());
  }
}

class GitIdentityController extends Controller {
  declare readonly element: HTMLFormElement;
  private timer: number | undefined;
  private saving = false;

  disconnect(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
  }

  queue(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.save(), 700);
  }

  submit(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  async save(): Promise<void> {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.saving || !this.element.checkValidity()) return;
    this.saving = true;
    const response = await fetch(this.element.action, {
      method: this.element.method || "POST",
      body: new FormData(this.element),
      headers: { Accept: "text/vnd.turbo-stream.html" },
    }).catch(() => undefined);
    this.saving = false;
    if (!response?.ok) return;
    const html = await response.text();
    window.Turbo?.renderStreamMessage(html);
    this.element.closest<HTMLElement>("[data-onboarding-target='pane']")?.setAttribute("data-onboarding-complete", "true");
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
  static targets = ["filter", "option"];
  declare readonly filterTarget: HTMLInputElement;
  declare readonly optionTargets: HTMLElement[];
  declare readonly hasFilterTarget: boolean;

  connect(): void {
    if (this.hasFilterTarget) requestAnimationFrame(() => this.filterTarget.focus());
  }

  filter(): void {
    const query = (this.hasFilterTarget ? this.filterTarget.value : "").trim().toLowerCase();
    this.optionTargets.forEach((option) => {
      option.hidden = query.length > 0 && !(option.dataset.searchText ?? "").includes(query);
    });
    this.element.querySelectorAll<HTMLElement>(".settings-add-model-group").forEach((group) => {
      const options = Array.from(group.querySelectorAll<HTMLElement>("[data-model-add-menu-target~='option']"));
      group.hidden = options.length > 0 && options.every((option) => option.hidden);
    });
  }
}

class OnboardingController extends Controller {
  static targets = ["pane", "dot", "continue", "back"];
  declare readonly paneTargets: HTMLElement[];
  declare readonly dotTargets: HTMLElement[];
  declare readonly continueTarget: HTMLButtonElement;
  declare readonly hasContinueTarget: boolean;
  declare readonly backTarget: HTMLButtonElement;
  declare readonly hasBackTarget: boolean;
  private index = 0;
  private observer?: MutationObserver;

  connect(): void {
    this.observer = new MutationObserver(() => this.show(this.index));
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-model-setup-working", "data-onboarding-complete"] });
    this.show(0);
  }

  disconnect(): void {
    this.observer?.disconnect();
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
    this.index = Math.max(0, Math.min(index, this.paneTargets.length - 1));
    this.paneTargets.forEach((pane, paneIndex) => pane.classList.toggle("active", paneIndex === this.index));
    this.dotTargets.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === this.index));
    const current = this.paneTargets[this.index];
    const kind = current?.dataset.onboardingKind;
    const modelSetup = current?.querySelector<HTMLElement>(".model-setup");
    const workingModel = modelSetup?.dataset.modelSetupWorking === "true";
    const complete = current?.dataset.onboardingComplete === "true" || (kind === "llm" && workingModel);
    if (kind === "done") this.refreshChecklist(current);
    const doneComplete = kind === "done" && current?.querySelector<HTMLElement>(".onboarding-step-done")?.dataset.onboardingDoneComplete === "true";
    if (this.hasBackTarget) {
      this.backTarget.hidden = this.index === 0;
      this.backTarget.disabled = this.index === 0;
    }
    if (this.hasContinueTarget) {
      this.continueTarget.classList.toggle("primary", kind === "done" ? Boolean(doneComplete) : complete);
      const label = kind === "done" ? (doneComplete ? "Let’s start!" : "Start anyway") : kind === "llm" && !workingModel ? "No model configured yet" : "Continue";
      if (this.continueTarget.textContent !== label) this.continueTarget.textContent = label;
    }
  }

  private refreshChecklist(donePane?: HTMLElement): void {
    const done = donePane?.querySelector<HTMLElement>(".onboarding-step-done");
    if (!done) return;
    done.querySelectorAll<HTMLElement>("[data-onboarding-check]").forEach((item) => {
      const id = item.dataset.onboardingCheck;
      const pane = this.paneTargets.find((candidate) => candidate.dataset.onboardingKind === id);
      const modelSetup = pane?.querySelector<HTMLElement>(".model-setup");
      const complete = pane ? (pane.dataset.onboardingComplete === "true" || (id === "llm" && modelSetup?.dataset.modelSetupWorking === "true")) : item.dataset.onboardingCheckComplete === "true";
      const completeValue = complete ? "true" : "false";
      if (item.dataset.onboardingCheckComplete !== completeValue) item.dataset.onboardingCheckComplete = completeValue;
      const marker = item.querySelector("span");
      const markerText = complete ? "✓" : "○";
      if (marker && marker.textContent !== markerText) marker.textContent = markerText;
    });
    const checks = Array.from(done.querySelectorAll<HTMLElement>("[data-onboarding-check]"));
    const completed = checks.filter((item) => item.dataset.onboardingCheckComplete === "true").length;
    const allComplete = completed === checks.length;
    done.dataset.onboardingDoneComplete = allComplete ? "true" : "false";
    const title = done.querySelector("h2");
    const titleText = allComplete ? "You’re all set up and ready to start using Atelier" : `${completed}/${checks.length} onboarding steps completed`;
    if (title && title.textContent !== titleText) title.textContent = titleText;
  }
}

class AgentModelMenuController extends Controller {
  declare readonly element: HTMLSelectElement;
  private button?: HTMLButtonElement;
  private menu?: HTMLDivElement;
  private observer?: MutationObserver;
  private form?: HTMLFormElement | null;

  connect(): void {
    if (this.element.dataset.agentModelEnhanced === "true") return;
    this.element.dataset.agentModelEnhanced = "true";
    this.element.classList.add("agent-sel-native");
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "agent-sel-button agent-model-button";
    this.button.addEventListener("click", this.toggle);
    this.menu = document.createElement("div");
    this.menu.className = "agent-sel-menu agent-model-menu hidden";
    this.element.after(this.button, this.menu);
    this.element.addEventListener("change", this.changed);
    this.form = this.element.form;
    this.form?.addEventListener("submit", this.submit, true);
    document.addEventListener("click", this.closeFromOutside);
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["selected", "disabled"] });
    this.sync();
  }

  disconnect(): void {
    this.button?.removeEventListener("click", this.toggle);
    this.element.removeEventListener("change", this.changed);
    this.form?.removeEventListener("submit", this.submit, true);
    document.removeEventListener("click", this.closeFromOutside);
    this.observer?.disconnect();
    this.button?.remove();
    this.menu?.remove();
    this.element.classList.remove("agent-sel-native");
    delete this.element.dataset.agentModelEnhanced;
  }

  private hasAvailableModel(): boolean {
    return Array.from(this.element.options).some((option) => !option.disabled && option.value);
  }

  private sync = (): void => {
    if (!this.button || !this.menu) return;
    const selected = this.element.selectedOptions[0];
    this.button.textContent = this.hasAvailableModel() ? (selected?.textContent?.trim() || "Select model") : "Configure favorite models";
    this.menu.innerHTML = "";
    const configure = document.createElement("button");
    configure.type = "button";
    configure.className = "agent-sel-option configure";
    configure.textContent = "Configure favorite models";
    configure.addEventListener("click", () => { this.close(); void this.openSetup(); });
    this.menu.appendChild(configure);
    Array.from(this.element.options).forEach((option) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `agent-sel-option${option.selected ? " selected" : ""}${option.disabled ? " disabled" : ""}`;
      item.disabled = option.disabled;
      const label = document.createElement("span");
      label.textContent = option.textContent ?? option.value;
      item.appendChild(label);
      if (option.disabled) {
        const reason = document.createElement("small");
        reason.textContent = option.dataset.unavailableReason ?? "Unavailable";
        item.appendChild(reason);
      } else if (option.selected) {
        const check = document.createElement("b");
        check.textContent = "✓";
        item.appendChild(check);
      }
      item.addEventListener("click", () => {
        if (option.disabled) return;
        this.element.value = option.value;
        this.element.dispatchEvent(new Event("change", { bubbles: true }));
        this.close();
      });
      this.menu?.appendChild(item);
    });
  };

  private changed = (): void => {
    this.sync();
    if (this.element.dataset.agentSessionModelSelect === "true") return;
    const value = this.element.value;
    if (!value) return;
    void fetch("/settings/models/active", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "text/vnd.turbo-stream.html" },
      body: new URLSearchParams({ model: value }),
    }).then((response) => response.text()).then((html) => { if (html) window.Turbo?.renderStreamMessage(html); }).catch(() => undefined);
  };

  private submit = (event: Event): void => {
    if (this.hasAvailableModel()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void this.openSetup();
  };

  private async openSetup(): Promise<void> {
    const html = await fetch("/settings/models/dialog", { headers: { Accept: "text/vnd.turbo-stream.html" } }).then((response) => response.text()).catch(() => "");
    if (html) window.Turbo?.renderStreamMessage(html);
  }

  private toggle = (event: MouseEvent): void => {
    event.stopPropagation();
    if (!this.hasAvailableModel()) {
      void this.openSetup();
      return;
    }
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
    const width = Math.max(220, Math.min(340, rect.width + 160));
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
for (const module of workspaceClientModules) await module.install({ application, Controller, hooks: clientHooks });
application.register("workspace-shell", WorkspaceShellController);
application.register("workspace-tabs", WorkspaceTabsController);
application.register("workspace-tab-close", WorkspaceTabCloseController);
application.register("workspace-groups", WorkspaceGroupsController);
application.register("workspace-residency", WorkspaceResidencyController);
application.register("atelier-shortcuts", AtelierShortcutsController);
application.register("submit-shortcut", SubmitShortcutController);
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("workspace-list", WorkspaceListController);
application.register("workspace-title-edit", WorkspaceTitleEditController);
application.register("provision-terminal", createProvisionTerminalController(Controller));
application.register("auto-scroll", AutoScrollController);
application.register("workspace-app-frame", WorkspaceAppFrameController);
application.register("theme-select", ThemeSelectController);
application.register("oauth-flow", OAuthFlowController);
application.register("git-identity", GitIdentityController);
application.register("settings-checkbox", SettingsCheckboxController);
application.register("provider-list", ProviderListController);
application.register("model-add-menu", ModelAddMenuController);
application.register("onboarding", OnboardingController);
application.register("clipboard", ClipboardController);
application.register("agent-select-menu", AgentSelectMenuController);
application.register("agent-model-menu", AgentModelMenuController);
