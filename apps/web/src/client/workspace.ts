/// <reference lib="dom" />

import { createAgentChatController, startAgentTab } from "@atelier/agent/client";
import { createContainerHealthController } from "@atelier/container-health/client";
import { createTerminalPaneController, createTerminalThemeController, initializeTerminalTheme, startTerminal, startTerminalTab } from "@atelier/terminal/client";

declare global {
  interface Window {
    Stimulus: {
      Application: { start(): { register(identifier: string, controllerConstructor: unknown): void; getControllerForElementAndIdentifier(element: Element, identifier: string): unknown } };
      Controller: new (...args: unknown[]) => { element: Element };
    };
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

const { Application, Controller } = window.Stimulus;

initializeTerminalTheme();

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

  stopPropagation(event: Event): void {
    event.stopPropagation();
  }

  activateTab(tabName: string, options: { persist?: boolean } = {}): void {
    this.ensurePane(tabName);

    this.element.querySelectorAll<HTMLElement>(".group-tab[data-tab]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === tabName);
      tab.classList.toggle("muted", tab.dataset.tab !== tabName);
    });
    this.group.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]").forEach((pane) => {
      pane.classList.toggle("active", pane.dataset.tabPane === tabName);
    });

    startTerminalTab(this.workspaceIdValue, tabName);
    startAgentTab(application, tabName, this.workspaceIdValue);
    if (options.persist !== false) void this.persistActiveTab(tabName);
  }

  private get group(): ParentNode & Element {
    return this.element.closest(".workspace-group") ?? this.root as ParentNode & Element;
  }

  private ensurePane(tabName: string): void {
    if (this.group.querySelector<HTMLElement>(`.tab-pane[data-tab-pane="${CSS.escape(tabName)}"]`)) return;
    const tab = this.element.querySelector<HTMLElement>(`.group-tab[data-tab="${CSS.escape(tabName)}"]`);
    const paneUrl = tab?.dataset.workspacePaneUrl;
    const panes = this.group.querySelector<HTMLElement>(".workspace-panes");
    if (!paneUrl || !panes) return;

    const placeholder = document.createElement("section");
    placeholder.className = "tab-pane active";
    placeholder.dataset.tabPane = tabName;
    placeholder.innerHTML = `<div class="workspace-wide"><div class="panel"><div class="pad"><span class="status-spinner" aria-label="Loading"></span> Loading…</div></div></div>`;
    panes.appendChild(placeholder);

    fetch(paneUrl, { headers: { "Accept": "text/html" } })
      .then((response) => response.ok ? response.text() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((html) => { placeholder.outerHTML = html; this.activateTab(tabName); })
      .catch((error) => { placeholder.innerHTML = `<div class="workspace-wide"><div class="panel"><div class="pad">Could not load tab: ${this.escapeHtml(error instanceof Error ? error.message : String(error))}</div></div></div>`; });
  }

  private async persistActiveTab(tabName: string): Promise<void> {
    await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/view-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeTab: tabName, groupId: this.groupIdValue }),
    }).catch(() => undefined);
  }

  private escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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

class ActivateTabController extends Controller {
  static values = { tab: String };
  declare readonly element: HTMLElement;
  declare readonly tabValue: string;

  connect(): void {
    const tabs = document.querySelector<HTMLElement>('.workspace-detail-resident.active .group-tab.active')?.closest<HTMLElement>('[data-controller~="workspace-tabs"]') ?? document.querySelector<HTMLElement>('.workspace-detail-resident.active [data-controller~="workspace-tabs"], [data-controller~="workspace-tabs"]');
    const controller = tabs ? application.getControllerForElementAndIdentifier(tabs, "workspace-tabs") as WorkspaceTabsController | null : null;
    controller?.activateTab(this.tabValue);
    this.element.remove();
  }
}

class RemoveWorkspaceResidentController extends Controller {
  static values = { workspaceId: String };
  declare readonly element: HTMLElement;
  declare readonly workspaceIdValue: string;

  connect(): void {
    const residency = document.querySelector<HTMLElement>('[data-controller~="workspace-residency"]');
    const controller = residency ? application.getControllerForElementAndIdentifier(residency, "workspace-residency") as WorkspaceResidencyController | null : null;
    controller?.removeWorkspace(this.workspaceIdValue);
    this.element.remove();
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

class RedirectController extends Controller {
  static values = { url: String, mode: String };
  declare readonly element: HTMLElement;
  declare readonly urlValue: string;
  declare readonly modeValue: string;

  connect(): void {
    if (this.modeValue === "replace") {
      history.pushState({}, "", this.urlValue);
      this.element.remove();
      return;
    }
    location.href = this.urlValue;
  }
}

class WorkspaceResidencyController extends Controller {
  static targets = ["resident"];
  static values = { maxResident: Number };
  declare readonly element: HTMLElement;
  declare readonly residentTargets: HTMLElement[];
  declare readonly maxResidentValue: number;

  async selectWorkspace(workspaceId: string, href: string): Promise<void> {
    const existing = this.residentTargets.find((resident) => resident.dataset.workspaceId === workspaceId);
    if (existing) {
      this.activateResident(existing);
      history.pushState({}, "", href);
      return;
    }

    const resident = await this.fetchResident(href);
    this.element.appendChild(resident);
    this.activateResident(resident);
    history.pushState({}, "", href);
    this.evictIfNeeded();
  }

  removeWorkspace(workspaceId: string): void {
    this.residentTargets.find((resident) => resident.dataset.workspaceId === workspaceId)?.remove();
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

class WorkspaceListController extends Controller {
  delete(event: Event): void {
    const form = event.currentTarget instanceof HTMLFormElement ? event.currentTarget : null;
    const row = form?.closest<HTMLElement>(".workspace-row");
    const selected = form?.querySelector<HTMLInputElement>('input[name="selected"]');
    if (selected) selected.value = row?.classList.contains("active") ? "1" : "0";
  }

  select(event: Event): void {
    const link = event.currentTarget instanceof HTMLAnchorElement ? event.currentTarget : null;
    const row = link?.closest<HTMLElement>(".workspace-row") ?? null;
    if (!row || !link) return;
    event.preventDefault();
    this.element.querySelectorAll<HTMLElement>(".workspace-row.active").forEach((activeRow) => activeRow.classList.remove("active"));
    row.classList.add("active");
    const workspaceId = row.dataset.workspaceId;
    const residency = document.querySelector<HTMLElement>('[data-controller~="workspace-residency"]');
    const controller = residency ? application.getControllerForElementAndIdentifier(residency, "workspace-residency") as WorkspaceResidencyController | null : null;
    if (workspaceId) void controller?.selectWorkspace(workspaceId, link.href);
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
application.register("workspace-tabs", WorkspaceTabsController);
application.register("workspace-groups", WorkspaceGroupsController);
application.register("workspace-residency", WorkspaceResidencyController);
application.register("terminal-pane", createTerminalPaneController(Controller));
application.register("terminal-theme", createTerminalThemeController(Controller));
application.register("agent-chat", createAgentChatController(Controller));
application.register("container-health", createContainerHealthController(Controller));
application.register("activate-tab", ActivateTabController);
application.register("remove-workspace-resident", RemoveWorkspaceResidentController);
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("redirect", RedirectController);
application.register("global-filter", GlobalFilterController);
application.register("workspace-list", WorkspaceListController);
application.register("workspace-title-edit", WorkspaceTitleEditController);
