/// <reference lib="dom" />

import { Application as StimulusApplication, Controller as StimulusController } from "@hotwired/stimulus";
// Turbo does not publish TypeScript declarations, but Bun resolves and bundles its browser module.
// @ts-expect-error No declaration file is included in @hotwired/turbo.
import * as Turbo from "@hotwired/turbo";
import { createHtmlAutocompleteController } from "@atelier/agent/client";
import {
  CableTopics,
  copyTextToClipboard,
  escapeHtml,
  looksLikeProjectSpec,
  isWorkspacePaneVisible,
  providerBrandIconHtml,
  workspaceProxyUrl,
  type AtelierCableClient,
  type WorkspaceClientTabVisibilityContext,
  type WorkspaceClientFocusContext,
  type WorkspaceClientHooks,
  type WorkspaceClientControllerConstructor,
  type WorkspaceClientWorkspaceAppFrameContext,
  type WorkspacePaletteItem,
  type WorkspacePaletteProvider,
  type WorkspacePaletteSearchContext,
} from "@atelier/shared";
import { createProvisionTerminalController } from "@atelier/workspace/client";
import { workspaceClientModules } from "./workspace-client-modules.generated.ts";
import { createAtelierCableClient } from "./cable.ts";

declare global {
  interface Window {
    Stimulus: {
      Application: { start(): { start(): Promise<void>; stop(): void; register(identifier: string, controllerConstructor: WorkspaceClientControllerConstructor): void; getControllerForElementAndIdentifier(element: Element, identifier: string): { element: Element } | null } };
      Controller: new (...args: never[]) => { element: Element };
    };
    Turbo?: { renderStreamMessage(html: string): void };
    AtelierCable?: AtelierCableClient;
  }
}

window.Stimulus = {
  Application: StimulusApplication as typeof window.Stimulus.Application,
  Controller: StimulusController as typeof window.Stimulus.Controller,
};
window.Turbo = Turbo;

const { Application, Controller } = window.Stimulus;

class WorkspaceClientHookRegistry implements WorkspaceClientHooks {
  private readonly becomeVisibleHandlers: Array<(context: WorkspaceClientTabVisibilityContext) => void> = [];
  private readonly noLongerVisibleHandlers: Array<(context: WorkspaceClientTabVisibilityContext) => void> = [];
  private readonly focusGroupHandlers: Array<(context: WorkspaceClientFocusContext) => boolean | void | Promise<boolean | void>> = [];
  private readonly workspaceCommandHandlers: Array<(commandId: string) => boolean | void | Promise<boolean | void>> = [];
  private readonly workspaceAppFrameUrlHandlers: Array<(context: WorkspaceClientWorkspaceAppFrameContext) => void> = [];
  private readonly workspaceAppFrameRefreshHandlers: Array<(context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void> = [];
  private readonly paletteProviders = new Map<string, WorkspacePaletteProvider>();

  onBecomeVisible(handler: (context: WorkspaceClientTabVisibilityContext) => void): void { this.becomeVisibleHandlers.push(handler); }
  onNoLongerVisible(handler: (context: WorkspaceClientTabVisibilityContext) => void): void { this.noLongerVisibleHandlers.push(handler); }
  onFocusGroup(handler: (context: WorkspaceClientFocusContext) => boolean | void | Promise<boolean | void>): void { this.focusGroupHandlers.push(handler); }
  onWorkspaceCommand(handler: (commandId: string) => boolean | void | Promise<boolean | void>): void { this.workspaceCommandHandlers.push(handler); }
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void { this.workspaceAppFrameUrlHandlers.push(handler); }
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void { this.workspaceAppFrameRefreshHandlers.push(handler); }
  registerPaletteProvider(provider: WorkspacePaletteProvider): void { this.paletteProviders.set(provider.id, provider); }

  becomeVisible(context: WorkspaceClientTabVisibilityContext): void {
    this.becomeVisibleHandlers.forEach((handler) => handler(context));
  }

  noLongerVisible(context: WorkspaceClientTabVisibilityContext): void {
    this.noLongerVisibleHandlers.forEach((handler) => handler(context));
  }

  async focusGroup(context: WorkspaceClientFocusContext): Promise<boolean> {
    for (const handler of this.focusGroupHandlers) {
      if (await handler(context)) return true;
    }
    return false;
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

  async searchPalette(query: string): Promise<PaletteResult[]> {
    const context: WorkspacePaletteSearchContext = { query, fuzzyScore: (candidate) => fuzzyScore(query, candidate) };
    const providerItems = await Promise.all([...this.paletteProviders.values()].map(async (provider) => {
      const items = await provider.search(context);
      return items.map((item) => ({ ...item, provider, score: item.score ?? this.paletteItemScore(query, item) }));
    }));
    return providerItems.flat()
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 30);
  }

  private paletteItemScore(query: string, item: WorkspacePaletteItem): number {
    return fuzzyScore(query, [item.title, item.subtitle, item.detail, item.badge, ...(item.keywords ?? [])].filter(Boolean).join(" "));
  }
}

type PaletteResult = WorkspacePaletteItem & { provider: WorkspacePaletteProvider; score: number };

const clientHooks = new WorkspaceClientHookRegistry();
const visiblePaneState = new WeakSet<HTMLElement>();

function fuzzyScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 1;
  if (!c) return 0;
  if (c === q) return 1000 + q.length;
  if (c.startsWith(q)) return 900 + q.length;
  const substringIndex = c.indexOf(q);
  if (substringIndex >= 0) return 760 + q.length - substringIndex;
  let score = 0;
  let lastIndex = -1;
  let streak = 0;
  for (const char of q) {
    const index = c.indexOf(char, lastIndex + 1);
    if (index < 0) return 0;
    streak = index === lastIndex + 1 ? streak + 1 : 1;
    score += 12 + streak * 8;
    if (index === 0 || /[\s/:._-]/.test(c[index - 1] ?? "")) score += 18;
    score -= Math.max(0, index - lastIndex - 1) * 0.4;
    lastIndex = index;
  }
  return Math.max(1, score - Math.max(0, c.length - q.length) * 0.05);
}

function tabVisibilityContext(pane: HTMLElement): WorkspaceClientTabVisibilityContext | undefined {
  const tabKey = pane.dataset.tabPane;
  const resident = pane.closest<HTMLElement>(".workspace-detail-resident[data-workspace-id]");
  const workspaceId = resident?.dataset.workspaceId;
  const group = pane.closest<HTMLElement>(".workspace-group");
  if (!tabKey || !workspaceId || !group) return undefined;
  return { workspaceId, tabKey, group, pane, application };
}

function visiblePanes(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".workspace-detail-resident.visible .tab-pane.visible[data-tab-pane]")];
}

function emitBecomeVisible(pane: HTMLElement): void {
  if (visiblePaneState.has(pane)) return;
  const context = tabVisibilityContext(pane);
  if (!context) return;
  visiblePaneState.add(pane);
  pane.querySelectorAll<HTMLIFrameElement>('[data-controller~="workspace-app-frame"]').forEach((frame) => {
    const controller = application.getControllerForElementAndIdentifier(frame, "workspace-app-frame") as { becomeVisible?(): void } | null;
    controller?.becomeVisible?.();
  });
  clientHooks.becomeVisible(context);
}

function emitNoLongerVisible(pane: HTMLElement): void {
  if (!visiblePaneState.has(pane)) return;
  const context = tabVisibilityContext(pane);
  if (!context) return;
  visiblePaneState.delete(pane);
  clientHooks.noLongerVisible(context);
}

function emitPaneVisibilityChanges(before: HTMLElement[], after: HTMLElement[]): void {
  const afterSet = new Set(after);
  const beforeSet = new Set(before);
  before.filter((pane) => !afterSet.has(pane)).forEach(emitNoLongerVisible);
  after.filter((pane) => !beforeSet.has(pane)).forEach(emitBecomeVisible);
}

type WorkspaceLayoutStreamElement = HTMLElement & {
  readonly targetElements: HTMLElement[];
  readonly templateContent: DocumentFragment;
};

function movePaneBefore(parent: ParentNode, pane: HTMLElement, reference: Node): void {
  const statePreservingParent = parent as ParentNode & { moveBefore?(node: Node, child: Node | null): void };
  if (statePreservingParent.moveBefore) statePreservingParent.moveBefore(pane, reference);
  else (parent as Node).insertBefore(pane, reference);
}

async function performWorkspaceLayoutReplacement(stream: WorkspaceLayoutStreamElement): Promise<void> {
  const before = visiblePanes(document);
  const replacements = stream.targetElements.map((target) => {
    const replacement = stream.templateContent.firstElementChild as HTMLElement | null;
    if (!replacement) throw new Error("workspace layout stream is missing its replacement");
    const livePanes = new Map([...target.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]")].map((pane) => [pane.dataset.tabPane!, pane]));
    for (const slot of replacement.querySelectorAll<HTMLElement>("[data-workspace-pane-slot]")) {
      const key = slot.dataset.workspacePaneSlot!;
      if (!livePanes.has(key)) throw new Error(`workspace layout cannot preserve missing pane ${key} in ${target.id}`);
    }
    return { target, replacement, livePanes };
  });

  application.stop();
  try {
    for (const { target, replacement, livePanes } of replacements) {
      target.before(replacement);

      for (const slot of replacement.querySelectorAll<HTMLElement>("[data-workspace-pane-slot]")) {
        const pane = livePanes.get(slot.dataset.workspacePaneSlot!);
        if (!pane) continue;
        pane.classList.toggle("visible", slot.dataset.visible === "true");
        movePaneBefore(slot.parentNode!, pane, slot);
        slot.remove();
      }

      for (const newPane of replacement.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]")) {
        const pane = livePanes.get(newPane.dataset.tabPane!);
        if (!pane || pane === newPane) continue;
        pane.classList.toggle("visible", newPane.classList.contains("visible"));
        movePaneBefore(newPane.parentNode!, pane, newPane);
        newPane.remove();
      }

      target.remove();
    }
  } finally {
    await application.start();
  }
  emitPaneVisibilityChanges(before, visiblePanes(document));
}

let workspaceLayoutRenderQueue = Promise.resolve();

function replaceWorkspaceLayout(this: WorkspaceLayoutStreamElement): Promise<void> {
  const render = workspaceLayoutRenderQueue.then(
    () => performWorkspaceLayoutReplacement(this),
    () => performWorkspaceLayoutReplacement(this),
  );
  workspaceLayoutRenderQueue = render;
  return render;
}

(Turbo.StreamActions as Record<string, (this: WorkspaceLayoutStreamElement) => void | Promise<void>>)["replace-workspace-layout"] = replaceWorkspaceLayout;

type FullscreenMode = "tab" | "template" | "media";
type FullscreenMediaElement = HTMLIFrameElement | HTMLImageElement | HTMLVideoElement;
type FullscreenViewer = { element: HTMLElement; disconnect?: () => void };
type FullscreenSession = { owner: AtelierFullscreenController; close(): void };

let hoveredFullscreenControllers: AtelierFullscreenController[] = [];
let fullscreenControllerCount = 0;
let activeFullscreenSession: FullscreenSession | undefined;

function editableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
}

function consumeFullscreenShortcut(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) return false;
  if (event.key.toLowerCase() === "f") {
    if (!activeFullscreenSession && !hoveredFullscreenControllers.at(-1)) return false;
    if (editableShortcutTarget(event.target)) return false;
  } else if (event.key !== "Escape" || !activeFullscreenSession) {
    return false;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
}

function documentFullscreenKeydown(event: KeyboardEvent): void {
  if (!consumeFullscreenShortcut(event)) return;
  if (activeFullscreenSession) activeFullscreenSession.close();
  else hoveredFullscreenControllers.at(-1)!.open();
}

function pushFullscreenHover(controller: AtelierFullscreenController): void {
  hoveredFullscreenControllers = hoveredFullscreenControllers.filter((candidate) => candidate !== controller);
  hoveredFullscreenControllers.push(controller);
}

function removeFullscreenHover(controller: AtelierFullscreenController): void {
  hoveredFullscreenControllers = hoveredFullscreenControllers.filter((candidate) => candidate !== controller);
}

class AtelierFullscreenController extends Controller {
  static values = { mode: String, tabKey: String, title: String };
  declare readonly element: HTMLElement;
  declare readonly modeValue: FullscreenMode;
  declare readonly tabKeyValue: string;
  declare readonly titleValue: string;
  private iframeLoadTargets: HTMLIFrameElement[] = [];
  private readonly pointerenter = (): void => {
    if (this.modeValue === "tab") this.element.focus({ preventScroll: true });
    pushFullscreenHover(this);
  };
  private readonly pointerleave = (): void => removeFullscreenHover(this);
  private readonly iframeLoaded = (event: Event): void => {
    const frame = event.currentTarget as HTMLIFrameElement;
    frame.contentDocument?.removeEventListener("keydown", documentFullscreenKeydown, true);
    frame.contentDocument?.addEventListener("keydown", documentFullscreenKeydown, true);
  };

  connect(): void {
    this.element.addEventListener("pointerenter", this.pointerenter);
    this.element.addEventListener("pointerleave", this.pointerleave);
    if (fullscreenControllerCount++ === 0) document.addEventListener("keydown", documentFullscreenKeydown, true);
  }

  disconnect(): void {
    removeFullscreenHover(this);
    this.detachIframeShortcuts();
    this.element.removeEventListener("pointerenter", this.pointerenter);
    this.element.removeEventListener("pointerleave", this.pointerleave);
    if (--fullscreenControllerCount === 0) document.removeEventListener("keydown", documentFullscreenKeydown, true);
    if (activeFullscreenSession?.owner === this) activeFullscreenSession.close();
  }

  open(): void {
    const wasActive = activeFullscreenSession?.owner === this;
    activeFullscreenSession?.close();
    if (wasActive) return;

    if (this.modeValue === "tab") this.openLiveTab();
    else this.openViewer();
  }

  private openLiveTab(): void {
    this.showTab();
    const target = this.liveTabTarget();
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    let session: FullscreenSession;
    let bar: HTMLElement;
    const close = (): void => {
      this.detachIframeShortcuts();
      target.classList.remove("atelier-fullscreen-live");
      target.removeAttribute("data-atelier-fullscreen-active");
      document.body.classList.remove("atelier-fullscreen-open");
      bar.remove();
      if (activeFullscreenSession === session) activeFullscreenSession = undefined;
      previousFocus?.focus({ preventScroll: true });
    };
    bar = this.createBar(close);
    bar.classList.add("atelier-fullscreen-live-bar");
    document.body.append(bar);
    document.body.classList.add("atelier-fullscreen-open");
    target.classList.add("atelier-fullscreen-live");
    target.dataset.atelierFullscreenActive = "true";
    session = { owner: this, close };
    activeFullscreenSession = session;
    this.attachIframeShortcuts(target);
    target.querySelector<HTMLElement>("iframe, .observable-terminal-host, textarea, input, button, [tabindex]")?.focus({ preventScroll: true });
  }

  private openViewer(): void {
    const viewer = this.createViewer();
    const dialog = document.createElement("dialog");
    dialog.className = "atelier-fullscreen-dialog";
    let session: FullscreenSession;
    const close = (): void => dialog.close();
    dialog.append(this.createBar(close), viewer.element);
    dialog.addEventListener("close", () => {
      this.detachIframeShortcuts();
      viewer.disconnect?.();
      dialog.remove();
      if (activeFullscreenSession === session) activeFullscreenSession = undefined;
    }, { once: true });
    document.body.append(dialog);
    session = { owner: this, close };
    activeFullscreenSession = session;
    dialog.showModal();
    this.attachIframeShortcuts(dialog);
  }

  private createBar(closeFullscreen: () => void): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "atelier-fullscreen-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Fullscreen controls");
    const title = document.createElement("span");
    title.textContent = this.titleValue;
    const hint = document.createElement("small");
    hint.textContent = "Press f or Esc to close";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "atelier-fullscreen-close";
    close.textContent = "Close";
    close.addEventListener("click", closeFullscreen);
    bar.append(title, hint, close);
    return bar;
  }

  private liveTabTarget(): HTMLElement {
    const group = this.element.closest<HTMLElement>(".workspace-group")!;
    return group.querySelector<HTMLElement>(`.workspace-panes > .tab-pane[data-tab-pane="${CSS.escape(this.tabKeyValue)}"]`)!;
  }

  private showTab(): void {
    const group = this.element.closest<HTMLElement>(".workspace-group")!;
    const tabbar = group.querySelector<HTMLElement>('[data-controller~="workspace-tabs"]')!;
    const controller = application.getControllerForElementAndIdentifier(tabbar, "workspace-tabs") as { element: Element; showTab(tabName: string): void };
    controller.showTab(this.tabKeyValue);
    this.element.closest<HTMLDetailsElement>("details")?.removeAttribute("open");
  }

  private createViewer(): FullscreenViewer {
    if (this.modeValue === "template") {
      const template = this.element.querySelector<HTMLTemplateElement>("template[data-atelier-fullscreen-target='content']")!;
      const container = document.createElement("div");
      container.className = "atelier-fullscreen-html";
      container.append(template.content.cloneNode(true));
      return { element: container };
    }
    const media = this.findMedia()!;
    return this.createMediaViewer(media, this.mediaSrc(media));
  }

  private findMedia(): FullscreenMediaElement | undefined {
    if (this.element instanceof HTMLIFrameElement || this.element instanceof HTMLImageElement || this.element instanceof HTMLVideoElement) return this.element;
    return this.element.querySelector<HTMLIFrameElement | HTMLImageElement | HTMLVideoElement>("iframe, img, video") ?? undefined;
  }

  private createMediaViewer(source: FullscreenMediaElement, src: string): FullscreenViewer {
    if (source instanceof HTMLIFrameElement) {
      const frame = document.createElement("iframe");
      frame.className = "atelier-fullscreen-frame";
      frame.src = src;
      for (const attr of ["sandbox", "allow", "referrerpolicy"] as const) {
        const value = source.getAttribute(attr);
        if (value !== null) frame.setAttribute(attr, value);
      }
      return { element: frame };
    }

    if (source instanceof HTMLVideoElement) {
      const video = document.createElement("video");
      video.className = "atelier-fullscreen-video";
      video.src = src;
      video.controls = true;
      video.autoplay = !source.paused;
      video.currentTime = source.currentTime;
      video.muted = source.muted;
      video.playbackRate = source.playbackRate;
      return {
        element: video,
        disconnect: () => {
          source.currentTime = video.currentTime;
          if (!video.paused && source.paused) void source.play();
        },
      };
    }

    const image = document.createElement("img");
    image.className = "atelier-fullscreen-image";
    image.src = src;
    image.alt = source.alt;
    return { element: image };
  }

  private mediaSrc(media: FullscreenMediaElement): string {
    if (media instanceof HTMLImageElement) return media.currentSrc || media.src || this.proxyUrl(media);
    if (media instanceof HTMLVideoElement) return media.currentSrc || media.src || this.proxyUrl(media);
    return media.src || this.proxyUrl(media);
  }

  private proxyUrl(element: HTMLElement): string {
    const workspaceId = element.dataset.agentProxyWorkspaceIdValue!;
    const appKey = element.dataset.agentProxyAppKeyValue!;
    const path = element.dataset.agentProxyPathValue || "/";
    return workspaceProxyUrl(workspaceId, appKey, path);
  }

  private attachIframeShortcuts(root: ParentNode): void {
    this.detachIframeShortcuts();
    this.iframeLoadTargets = [...root.querySelectorAll<HTMLIFrameElement>("iframe")];
    for (const frame of this.iframeLoadTargets) {
      frame.addEventListener("load", this.iframeLoaded);
      frame.contentDocument?.addEventListener("keydown", documentFullscreenKeydown, true);
    }
  }

  private detachIframeShortcuts(): void {
    for (const frame of this.iframeLoadTargets) {
      frame.removeEventListener("load", this.iframeLoaded);
      frame.contentDocument?.removeEventListener("keydown", documentFullscreenKeydown, true);
    }
    this.iframeLoadTargets = [];
  }
}

class WorkspaceShellController extends Controller {
  static targets = ["toggle"];
  declare readonly element: HTMLElement;
  declare readonly toggleTarget: HTMLButtonElement;

  toggle(): void {
    this.element.classList.toggle("workspace-shell-collapsed");
    const collapsed = this.element.classList.contains("workspace-shell-collapsed");
    const label = `${collapsed ? "Show" : "Hide"} workspace pane`;
    this.toggleTarget.setAttribute("aria-expanded", String(!collapsed));
    this.toggleTarget.setAttribute("aria-label", label);
    this.toggleTarget.title = label;
  }
}

class WorkspaceTabsController extends Controller {
  static values = { workspaceId: String, groupId: String, initialTab: String };
  declare readonly element: HTMLElement;
  declare readonly workspaceIdValue: string;
  declare readonly groupIdValue: string;
  declare readonly initialTabValue: string;
  declare readonly hasInitialTabValue: boolean;
  private resizeObserver: ResizeObserver | undefined;
  private overflowFrame = 0;

  connect(): void {
    const visibleTab = this.hasInitialTabValue && this.initialTabValue
      ? this.initialTabValue
      : this.element.querySelector<HTMLElement>(".group-tab.visible[data-tab]")?.dataset.tab;
    if (visibleTab) this.showTab(visibleTab, { persist: false, emitCurrent: true });
    this.resizeObserver = new ResizeObserver(() => this.scheduleOverflowLayout());
    this.resizeObserver.observe(this.element);
    document.fonts.ready.then(() => this.scheduleOverflowLayout());
    this.scheduleOverflowLayout();
  }

  disconnect(): void {
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.overflowFrame);
  }

  private get root(): ParentNode {
    return this.element.closest("[data-workspace-id]") ?? document;
  }

  show(event: Event & { params?: { tab?: string } }): void {
    const tabName = event.params?.tab ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.tab : undefined);
    if (!tabName) return;
    this.element.querySelector<HTMLDetailsElement>(".group-overflow-menu")?.removeAttribute("open");
    this.showTab(tabName);
  }

  showTab(tabName: string, options: { persist?: boolean; emitLifecycle?: boolean; emitCurrent?: boolean } = {}): void {
    const group = this.group;
    const before = group.querySelector<HTMLElement>(".tab-pane.visible[data-tab-pane]");
    const beforeWasVisible = before ? isWorkspacePaneVisible(before) : false;
    this.element.querySelectorAll<HTMLElement>(".group-tab[data-tab]").forEach((tab) => {
      tab.classList.toggle("visible", tab.dataset.tab === tabName);
      tab.classList.toggle("muted", tab.dataset.tab !== tabName);
    });
    group.querySelectorAll<HTMLElement>(".tab-pane[data-tab-pane]").forEach((pane) => {
      pane.classList.toggle("visible", pane.dataset.tabPane === tabName);
    });

    const after = group.querySelector<HTMLElement>(`.tab-pane.visible[data-tab-pane="${CSS.escape(tabName)}"]`);
    if (options.emitLifecycle !== false) {
      if (before && before !== after && beforeWasVisible) emitNoLongerVisible(before);
      if (after && before !== after && isWorkspacePaneVisible(after)) emitBecomeVisible(after);
      if (after && before === after && options.emitCurrent && isWorkspacePaneVisible(after)) emitBecomeVisible(after);
    }
    this.scheduleOverflowLayout();
    if (options.persist !== false) void this.persistVisibleTab(tabName);
  }

  private scheduleOverflowLayout(): void {
    cancelAnimationFrame(this.overflowFrame);
    this.overflowFrame = requestAnimationFrame(() => this.layoutOverflow());
  }

  private layoutOverflow(): void {
    const tabsContainer = this.element.querySelector<HTMLElement>(".group-tabs")!;
    const overflowMenu = this.element.querySelector<HTMLElement>(".group-overflow-menu")!;
    const tabs = [...tabsContainer.querySelectorAll<HTMLElement>(".group-tab[data-tab]")];
    const overflowTabs = [...overflowMenu.querySelectorAll<HTMLElement>(".group-overflow-tab[data-overflow-tab]")];

    for (const tab of tabs) tab.classList.remove("overflowed");
    for (const tab of overflowTabs) tab.classList.remove("overflowed", "visible");
    overflowMenu.classList.remove("has-overflow");
    overflowMenu.removeAttribute("open");

    if (tabsContainer.scrollWidth <= tabsContainer.clientWidth) return;

    overflowMenu.classList.add("has-overflow");
    const candidates = tabs.filter((tab) => !tab.classList.contains("visible")).reverse();
    for (const tab of candidates) {
      if (tabsContainer.scrollWidth <= tabsContainer.clientWidth) break;
      tab.classList.add("overflowed");
    }

    const hiddenTabs = new Set(tabs.filter((tab) => tab.classList.contains("overflowed")).map((tab) => tab.dataset.tab!));
    const visibleTab = tabs.find((tab) => tab.classList.contains("visible"))?.dataset.tab;
    for (const tab of overflowTabs) {
      const tabName = tab.dataset.overflowTab!;
      tab.classList.toggle("overflowed", hiddenTabs.has(tabName));
      tab.classList.toggle("visible", tabName === visibleTab);
    }
    overflowMenu.classList.toggle("has-overflow", hiddenTabs.size > 0);
  }

  private get group(): ParentNode & Element {
    return this.element.closest(".workspace-group") ?? this.root as ParentNode & Element;
  }

  private async persistVisibleTab(tabName: string): Promise<void> {
    await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/view-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibleTab: tabName, groupId: this.groupIdValue }),
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

type WorkspaceLayoutMutation =
  | { tab: string; fromGroup: string; newGroup: true }
  | { tab: string; fromGroup: string; toGroup: string; toIndex: number };

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

  private async renderStream(url: string, body: WorkspaceLayoutMutation): Promise<void> {
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
  private paletteDialog: HTMLDialogElement | undefined;
  private paletteInput: HTMLInputElement | undefined;
  private paletteResults: HTMLElement | undefined;
  private paletteItems: PaletteResult[] = [];
  private paletteIndex = 0;
  private paletteSearchTimer: ReturnType<typeof setTimeout> | undefined;
  private paletteSearchSeq = 0;

  connect(): void {
    this.registerBuiltinCommands();
    clientHooks.registerPaletteProvider({
      id: "atelier.commands",
      label: "Command",
      search: () => this.currentCommands()
        .filter((command) => command.id !== "atelier.open-palette")
        .map((command) => ({
          id: `command:${command.id}`,
          title: command.label,
          subtitle: command.description,
          badge: command.binding ? this.formatBinding(command.binding) : undefined,
          keywords: [command.id, command.scope, command.binding ?? ""],
          run: command.run,
        })),
    });
    clientHooks.registerPaletteProvider({
      id: "atelier.workspaces",
      label: "Workspace",
      search: ({ fuzzyScore }) => this.workspacePaletteItems(fuzzyScore),
    });
    clientHooks.registerPaletteProvider({
      id: "atelier.tabs",
      label: "Tab",
      search: ({ fuzzyScore }) => this.workspaceTabPaletteItems(fuzzyScore),
    });
    // Listen at window capture so we get first chance at shortcuts that focused
    // Atelier-owned widgets (not iframes) might otherwise consume.
    window.addEventListener("keydown", this.keydown, true);
    window.addEventListener("keyup", this.keyup, true);
    window.addEventListener("blur", this.shortcutBlur);
  }

  disconnect(): void {
    window.removeEventListener("keydown", this.keydown, true);
    window.removeEventListener("keyup", this.keyup, true);
    window.removeEventListener("blur", this.shortcutBlur);
    this.hideShortcutOverlay();
    this.closePalette();
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.repeat || event.isComposing) return;
    if (!event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey) return;

    if (event.key === "Meta" || event.key === "Alt") {
      this.scheduleShortcutOverlay();
      return;
    }

    this.hideShortcutOverlay();
    if (this.matchesBinding(event, "Meta+Alt+KeyK")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.openPalette();
      return;
    }
    const command = this.currentCommands().find((candidate) => candidate.binding && this.matchesBinding(event, candidate.binding));
    if (!command) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void command.run();
  };

  private readonly keyup = (event: KeyboardEvent): void => {
    if (!event.metaKey || !event.altKey) this.hideShortcutOverlay();
  };

  private readonly shortcutBlur = (): void => {
    this.hideShortcutOverlay();
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
      id: "workspace.new",
      label: "New workspace",
      scope: "global",
      binding: "Meta+Alt+Semicolon",
      run: () => this.openDialogPrompt("project-picker-modal"),
    });
    this.registerCommand({
      id: "atelier.open-palette",
      label: "Open palette",
      scope: "global",
      binding: "Meta+Alt+KeyK",
      run: () => this.openPalette(),
    });
    this.registerCommand({
      id: "atelier.open-settings",
      label: "Open settings",
      scope: "global",
      run: () => this.openSettingsDialog(),
    });
  }

  private currentCommands(): CommandRegistration[] {
    const deleteCommand = this.visibleWorkspaceDeleteCommand();
    return [
      ...this.commands.values(),
      ...(deleteCommand ? [deleteCommand] : []),
      ...this.workspaceCommands().map((command) => ({
        ...command,
        run: () => this.executeVisibleWorkspaceCommand(command.id),
      })),
    ];
  }

  private visibleWorkspaceDeleteCommand(): CommandRegistration | undefined {
    if (!this.visibleWorkspaceDeleteForm()) return undefined;
    return {
      id: "workspace.delete",
      label: "Delete workspace",
      description: "Delete the current workspace",
      scope: "workspace",
      binding: "Meta+Alt+Backspace",
      run: () => this.deleteVisibleWorkspace(),
    };
  }

  private visibleWorkspaceDeleteForm(): HTMLFormElement | null {
    const workspaceId = this.visibleWorkspaceId();
    if (!workspaceId) return null;
    return document.querySelector<HTMLFormElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"] form.workspace-row-delete[action$="/delete"]`);
  }

  private deleteVisibleWorkspace(): void {
    const form = this.visibleWorkspaceDeleteForm();
    if (form) submitFormWithFirstButton(form);
  }

  private workspaceCommands(): WorkspaceCommandRegistration[] {
    const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.visible");
    const groups = resident?.querySelector<HTMLElement>(".workspace-groups[data-workspace-commands]");
    return groups ? JSON.parse(groups.dataset.workspaceCommands!) as WorkspaceCommandRegistration[] : [];
  }

  private scheduleShortcutOverlay(): void {
    if (this.shortcutOverlay || this.shortcutOverlayTimer) return;
    this.shortcutOverlayTimer = setTimeout(() => {
      this.shortcutOverlayTimer = undefined;
      this.showShortcutOverlay();
    }, 500);
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
        case "Backspace": return "⌫";
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

  private async openPalette(): Promise<void> {
    this.ensurePalette();
    if (!this.paletteDialog!.open) this.paletteDialog!.showModal();
    this.paletteInput!.value = "";
    this.paletteInput!.focus();
    await this.searchPaletteNow();
  }

  private closePalette(): void {
    if (this.paletteSearchTimer) clearTimeout(this.paletteSearchTimer);
    this.paletteSearchTimer = undefined;
    this.paletteDialog?.remove();
    this.paletteDialog = undefined;
    this.paletteInput = undefined;
    this.paletteResults = undefined;
    this.paletteItems = [];
  }

  private ensurePalette(): void {
    if (this.paletteDialog) return;
    const dialog = document.createElement("dialog");
    dialog.className = "palette-dialog";
    dialog.innerHTML = `<div class="palette-panel"><input class="palette-input" type="text" spellcheck="false" autocomplete="off" placeholder="Search your Atelier" aria-label="Search palette"><div class="palette-results" role="listbox"></div></div>`;
    dialog.addEventListener("close", () => this.paletteInput?.blur());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    const input = dialog.querySelector<HTMLInputElement>(".palette-input")!;
    const results = dialog.querySelector<HTMLElement>(".palette-results")!;
    input.addEventListener("input", () => this.schedulePaletteSearch());
    input.addEventListener("keydown", (event) => this.paletteKeydown(event));
    results.addEventListener("mousemove", (event) => this.palettePointerMove(event));
    results.addEventListener("click", (event) => this.paletteClick(event));
    document.body.append(dialog);
    this.paletteDialog = dialog;
    this.paletteInput = input;
    this.paletteResults = results;
  }

  private schedulePaletteSearch(): void {
    if (this.paletteSearchTimer) clearTimeout(this.paletteSearchTimer);
    this.paletteSearchTimer = setTimeout(() => {
      this.paletteSearchTimer = undefined;
      void this.searchPaletteNow();
    }, 60);
  }

  private async searchPaletteNow(): Promise<void> {
    const seq = ++this.paletteSearchSeq;
    const query = this.paletteInput?.value ?? "";
    const items = await clientHooks.searchPalette(query);
    if (seq !== this.paletteSearchSeq) return;
    this.paletteItems = items;
    this.paletteIndex = 0;
    this.renderPaletteResults();
  }

  private paletteKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.paletteDialog?.close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (this.paletteItems.length === 0) return;
      this.paletteIndex = (this.paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + this.paletteItems.length) % this.paletteItems.length;
      this.renderPaletteResults();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void this.runPaletteItem(this.paletteItems[this.paletteIndex]);
    }
  }

  private renderPaletteResults(): void {
    const results = this.paletteResults;
    if (!results) return;
    if (this.paletteItems.length === 0) {
      results.innerHTML = `<div class="palette-empty">No matches</div>`;
      return;
    }
    results.innerHTML = this.paletteItems.map((item, index) => `<button type="button" class="palette-item${index === this.paletteIndex ? " active" : ""}" data-palette-index="${index}" role="option" aria-selected="${index === this.paletteIndex ? "true" : "false"}">
        <span class="palette-kind">${escapeHtml(item.provider.label)}</span>
        <span class="palette-thing">
          <span class="palette-item-main"><span class="palette-title">${escapeHtml(item.title)}</span>${item.subtitle ? `<span class="palette-subtitle">${escapeHtml(item.subtitle)}</span>` : ""}${item.detail ? `<span class="palette-detail">${escapeHtml(item.detail)}</span>` : ""}</span>
          ${item.badge ? `<span class="palette-badge">${escapeHtml(item.badge)}</span>` : ""}
        </span>
      </button>`).join("");
    results.querySelector<HTMLElement>(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }

  private palettePointerMove(event: MouseEvent): void {
    const index = this.paletteEventIndex(event);
    if (index === undefined || index === this.paletteIndex) return;
    this.paletteIndex = index;
    this.renderPaletteResults();
  }

  private paletteClick(event: MouseEvent): void {
    const index = this.paletteEventIndex(event);
    if (index === undefined) return;
    void this.runPaletteItem(this.paletteItems[index]);
  }

  private paletteEventIndex(event: Event): number | undefined {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".palette-item[data-palette-index]") : null;
    if (!target) return undefined;
    const index = Number(target.dataset.paletteIndex);
    return Number.isFinite(index) ? index : undefined;
  }

  private async runPaletteItem(item: PaletteResult | undefined): Promise<void> {
    if (!item) return;
    this.paletteDialog?.close();
    await item.run();
  }

  private workspacePaletteItems(fuzzyScore: (candidate: string) => number): WorkspacePaletteItem[] {
    return this.workspaceRows().map((row) => {
      const workspaceId = row.dataset.workspaceId!;
      const title = row.querySelector<HTMLElement>(".r-title")?.textContent?.trim() || workspaceId;
      const phase = row.dataset.phase ?? "ready";
      const parked = row.dataset.parked === "true" || row.classList.contains("parked");
      const visible = row.classList.contains("visible") || residencyController()?.visibleWorkspaceId() === workspaceId;
      return {
        id: `workspace:${workspaceId}`,
        title,
        subtitle: parked ? "Parked workspace" : "Workspace",
        badge: visible ? "open" : phase,
        keywords: [workspaceId, phase, parked ? "parked" : ""],
        score: fuzzyScore([title, workspaceId, phase, parked ? "parked" : ""].join(" ")) + (visible ? 15 : 0) - (parked ? 8 : 0),
        run: () => this.openWorkspaceRow(row),
      };
    });
  }

  private workspaceTabPaletteItems(fuzzyScore: (candidate: string) => number): WorkspacePaletteItem[] {
    const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.visible[data-workspace-id]");
    if (!resident) return [];
    const workspaceId = resident.dataset.workspaceId!;
    const workspaceTitle = document.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"] .r-title`)?.textContent?.trim() ?? workspaceId;
    const groups = [...resident.querySelectorAll<HTMLElement>(".workspace-group[data-group-id]")];
    return groups.flatMap((group) => [...group.querySelectorAll<HTMLElement>(".group-tab[data-tab]")].map((tab) => {
      const groupId = group.dataset.groupId!;
      const tabName = tab.dataset.tab!;
      const label = tab.querySelector<HTMLElement>(".group-tab-label span")?.textContent?.trim() || tabName;
      const visible = tab.classList.contains("visible");
      return {
        id: `tab:${workspaceId}:${groupId}:${tabName}`,
        title: label,
        subtitle: workspaceTitle,
        detail: groups.length > 1 ? `Group ${groupId}` : undefined,
        badge: visible ? "open" : undefined,
        keywords: [tabName, groupId],
        score: fuzzyScore([label, tabName].join(" ")) + (visible ? 20 : 0),
        run: () => this.openCurrentWorkspaceTab(groupId, tabName),
      };
    }));
  }

  private workspaceRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".workspace-row[data-workspace-id]")]
      .filter((row) => !row.classList.contains("pending-delete") && row.dataset.phase !== "checking_delete" && row.dataset.phase !== "deleting");
  }

  private async openWorkspaceRow(row: HTMLElement): Promise<void> {
    const workspaceId = row.dataset.workspaceId;
    const href = row.querySelector<HTMLAnchorElement>("a.row-main")?.href;
    if (!workspaceId || !href) return;
    workspaceListController()?.markVisibleWorkspace(workspaceId);
    await residencyController()?.selectWorkspace(workspaceId, href);
  }

  private openCurrentWorkspaceTab(groupId: string, tabName: string): void {
    const group = document.querySelector<HTMLElement>(`.workspace-detail-resident.visible .workspace-group[data-group-id="${CSS.escape(groupId)}"]`);
    group?.querySelector<HTMLButtonElement>(`.group-tab[data-tab="${CSS.escape(tabName)}"] .group-tab-label`)?.click();
  }

  private async openSettingsDialog(): Promise<void> {
    const response = await fetch("/settings", { headers: { "Accept": "text/vnd.turbo-stream.html" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (html) window.Turbo?.renderStreamMessage(html);
  }

  private openDialogPrompt(id: string): void {
    const dialog = document.getElementById(id) as HTMLDialogElement | null;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    focusDialogPromptEnd(dialog);
  }

  private visibleWorkspaceId(): string | undefined {
    return document.querySelector<HTMLElement>(".workspace-row.visible[data-workspace-id]")?.dataset.workspaceId
      ?? residencyController()?.visibleWorkspaceId();
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
    workspaceListController()?.markVisibleWorkspace(workspaceId);
    void residencyController()?.selectWorkspace(workspaceId, url.pathname);
  }

  private async openAdjacentWorkspace(direction: -1 | 1): Promise<void> {
    const rows = this.workspaceRows();
    if (rows.length === 0) return;
    const currentWorkspaceId = this.visibleWorkspaceId();
    const currentIndex = currentWorkspaceId ? rows.findIndex((row) => row.dataset.workspaceId === currentWorkspaceId) : -1;
    const row = this.adjacentUnparkedWorkspaceRow(rows, currentIndex, direction);
    if (row) await this.openWorkspaceRow(row);
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

  private async executeVisibleWorkspaceCommand(commandId: string): Promise<void> {
    const workspaceId = this.visibleWorkspaceId();
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

function submitFormWithFirstButton(form: HTMLFormElement): void {
  const submitter = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
  form.requestSubmit(submitter ?? undefined);
}

class SubmitShortcutController extends Controller {
  private submitting = false;

  keydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    if (this.submitting) return;
    submitFormWithFirstButton(event.currentTarget as HTMLFormElement);
  }

  submit(event: SubmitEvent): void {
    if (!this.submitting) {
      this.submitting = true;
      return;
    }
    event.preventDefault();
  }

  submitted(): void {
    this.submitting = false;
  }
}

class WorkspaceCommandFormController extends Controller {
  declare readonly element: HTMLFormElement;
  private originalHtml?: string;

  start(): void {
    const button = this.element.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
    if (!button) return;
    this.originalHtml = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `<span class="status-spinner sm" aria-hidden="true"></span><span>Adding…</span>`;
  }

  end(): void {
    const button = this.element.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
    if (!button) return;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (this.originalHtml !== undefined) button.innerHTML = this.originalHtml;
  }
}

class ModalController extends Controller {
  static values = { autoShow: Boolean };
  declare readonly element: HTMLDialogElement;
  declare readonly autoShowValue: boolean;
  private readonly onClose = (): void => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeElement?.blur();
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

class AgentLaunchDialogController extends Controller {
  static values = { discardUrl: String };
  declare readonly element: HTMLDialogElement;
  declare readonly discardUrlValue: string;

  connect(): void {
    this.element.addEventListener("close", this.closed);
    this.element.showModal();
    focusDialogPromptEnd(this.element);
  }

  disconnect(): void {
    this.element.removeEventListener("close", this.closed);
  }

  private readonly closed = (): void => {
    void fetch(this.discardUrlValue, { method: "POST" }).catch((error) => console.error("Could not discard attachment draft", error));
    const frame = this.element.closest("turbo-frame")!;
    frame.removeAttribute("src");
    frame.replaceChildren();
  };
}

class ModalOpenerController extends Controller {
  static values = { targetId: String };
  declare readonly element: HTMLElement;
  declare readonly targetIdValue: string;

  open(event?: Event): void {
    const target = event?.target instanceof HTMLElement ? event.target : null;
    const interactive = target?.closest("a, button, input, textarea, select, form");
    if (interactive && interactive !== this.element) return;
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
  private readonly residentLoads = new Map<string, Promise<HTMLElement>>();

  connect(): void {
    document.addEventListener("visibilitychange", this.visibilityChanged);
    window.addEventListener("pagehide", this.pageHidden);
    const workspaceId = location.pathname.match(/^\/workspaces\/([^/]+)$/)?.[1];
    const visibleResident = this.residentTargets.find((resident) => resident.classList.contains("visible"))
      ?? (workspaceId ? this.residentTargets.find((resident) => resident.dataset.workspaceId === decodeURIComponent(workspaceId)) : undefined);
    if (visibleResident) this.showResident(visibleResident);
    this.reconcileResidents();
  }

  disconnect(): void {
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    window.removeEventListener("pagehide", this.pageHidden);
  }

  async selectWorkspace(workspaceId: string, href: string): Promise<void> {
    // Update the URL first: selection state is derived from it, and stream
    // broadcasts arriving while the resident loads must not flip selection back.
    const seq = ++this.selectionSeq;
    history.pushState({}, "", href);
    const existing = this.residentTargets.find((resident) => resident.dataset.workspaceId === workspaceId);
    if (existing) {
      this.showResident(existing);
      return;
    }

    // Hide the previous workspace immediately: it must not keep receiving
    // input (e.g. typing into its agent field) while the new one loads.
    this.showLoading();

    let resident: HTMLElement;
    try {
      resident = await this.ensureResident(workspaceId);
    } catch (error) {
      if (seq !== this.selectionSeq) return;
      this.showLoadError(error);
      return;
    }
    // Only show it if no newer selection happened while we were fetching;
    // the resident stays cached either way.
    if (seq === this.selectionSeq) this.showResident(resident);
    this.evictIfNeeded();
  }

  reconcileResidents(): void {
    void this.preloadUnreadResidents().catch((error) => console.error("Could not preload unread workspaces", error));
  }

  residentTargetConnected(resident: HTMLElement): void {
    // Broadcast residents (e.g. the boot placeholder being replaced by the real
    // detail) arrive without a "visible" class; show them only if this client
    // is currently looking at that workspace.
    if (resident.classList.contains("visible")) return;
    const workspaceId = resident.dataset.workspaceId;
    if (!workspaceId) return;
    if (location.pathname === `/workspaces/${encodeURIComponent(workspaceId)}`) this.showResident(resident);
  }

  removeWorkspace(workspaceId: string): void {
    const resident = this.residentTargets.find((candidate) => candidate.dataset.workspaceId === workspaceId);
    if (!resident) return;
    const wasVisible = resident.classList.contains("visible");
    if (wasVisible) visiblePanes(resident).forEach(emitNoLongerVisible);
    resident.remove();
    if (wasVisible) this.showEmpty();
  }

  visibleWorkspaceId(): string | undefined {
    return this.residentTargets.find((resident) => resident.classList.contains("visible"))?.dataset.workspaceId;
  }

  private hideResidents(): void {
    const before = visiblePanes(this.element);
    this.residentTargets.forEach((resident) => resident.classList.remove("visible"));
    emitPaneVisibilityChanges(before, visiblePanes(this.element));
    if (before.length > 0) this.clearActiveWorkspace();
  }

  private showEmpty(): void {
    this.hideResidents();
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    this.emptyTargets.forEach((empty) => { empty.hidden = false; });
  }

  private showLoading(): void {
    this.hideResidents();
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => {
      loading.hidden = false;
      const pad = loading.querySelector<HTMLElement>(".pad");
      if (pad) pad.innerHTML = `<span class="status-spinner"></span> Loading workspace…`;
    });
  }

  private showLoadError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.hideResidents();
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => {
      loading.hidden = false;
      const pad = loading.querySelector<HTMLElement>(".pad");
      if (pad) pad.textContent = `Could not load workspace: ${message}`;
    });
  }

  private async ensureResident(workspaceId: string): Promise<HTMLElement> {
    const existing = this.residentTargets.find((resident) => resident.dataset.workspaceId === workspaceId);
    if (existing) return existing;
    const loading = this.residentLoads.get(workspaceId);
    if (loading) return await loading;
    const promise = this.fetchResident(workspaceId).then((resident) => {
      const connected = this.residentTargets.find((candidate) => candidate.dataset.workspaceId === workspaceId);
      if (connected) return connected;
      this.element.appendChild(resident);
      return resident;
    }).finally(() => this.residentLoads.delete(workspaceId));
    this.residentLoads.set(workspaceId, promise);
    return await promise;
  }

  private async fetchResident(workspaceId: string): Promise<HTMLElement> {
    const url = new URL(`/workspaces/${encodeURIComponent(workspaceId)}`, location.href);
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
    resident.classList.remove("visible");
    return resident;
  }

  private async preloadUnreadResidents(): Promise<void> {
    const visibleWorkspaceId = this.visibleWorkspaceId();
    const available = this.maxResidentValue - (visibleWorkspaceId ? 1 : 0);
    const candidates = this.unreadWorkspaces()
      .filter(({ workspaceId }) => workspaceId !== visibleWorkspaceId)
      .slice(0, available);
    await Promise.all(candidates.map(({ workspaceId }) => this.preloadResident(workspaceId)));
    this.evictIfNeeded();
  }

  private async preloadResident(workspaceId: string): Promise<void> {
    if (this.residentTargets.some((resident) => resident.dataset.workspaceId === workspaceId)) return;
    workspaceListController()?.setWorkspacePreloading(workspaceId, true);
    try {
      await this.ensureResident(workspaceId);
    } finally {
      workspaceListController()?.setWorkspacePreloading(workspaceId, false);
    }
  }

  isWorkspacePreloading(workspaceId: string): boolean {
    return this.residentLoads.has(workspaceId);
  }

  private unreadWorkspaces(): Array<{ workspaceId: string; unreadAt: number }> {
    return [...document.querySelectorAll<HTMLElement>(".workspace-status[data-workspace-unread-at]")]
      .map((status) => ({
        workspaceId: status.closest<HTMLElement>(".workspace-row[data-workspace-id]")!.dataset.workspaceId!,
        unreadAt: Number(status.dataset.workspaceUnreadAt),
      }))
      .sort((a, b) => a.unreadAt - b.unreadAt || a.workspaceId.localeCompare(b.workspaceId));
  }

  private showResident(resident: HTMLElement): void {
    const before = visiblePanes(this.element);
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    resident.dataset.lastActivatedAt = String(Date.now());
    this.residentTargets.forEach((candidate) => candidate.classList.toggle("visible", candidate === resident));
    const tabs = resident.querySelector<HTMLElement>('[data-controller~="workspace-tabs"]');
    const controller = tabs ? application.getControllerForElementAndIdentifier(tabs, "workspace-tabs") as WorkspaceTabsController | null : null;
    const visibleTab = tabs?.querySelector<HTMLElement>(".group-tab.visible[data-tab]")?.dataset.tab;
    if (visibleTab) controller?.showTab(visibleTab, { persist: false, emitLifecycle: false });
    emitPaneVisibilityChanges(before, visiblePanes(this.element));
    const workspaceId = resident.dataset.workspaceId;
    if (workspaceId) void this.markActiveWorkspace(workspaceId);
  }

  private async markActiveWorkspace(workspaceId: string): Promise<void> {
    if (document.visibilityState !== "visible") return;
    const html = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/active`, {
      method: "POST",
      headers: { "Accept": "text/vnd.turbo-stream.html" },
    }).then((response) => response.text());
    if (html) window.Turbo?.renderStreamMessage(html);
  }

  private clearActiveWorkspace(): void {
    void fetch("/workspaces/active/clear", { method: "POST", headers: { "Accept": "text/vnd.turbo-stream.html" }, keepalive: true });
  }

  private readonly visibilityChanged = (): void => {
    if (document.visibilityState !== "visible") {
      this.clearActiveWorkspace();
      return;
    }
    const workspaceId = this.visibleWorkspaceId();
    if (workspaceId) void this.markActiveWorkspace(workspaceId);
  };

  private readonly pageHidden = (): void => this.clearActiveWorkspace();

  private evictIfNeeded(): void {
    const unreadAt = new Map(this.unreadWorkspaces().map((workspace) => [workspace.workspaceId, workspace.unreadAt]));
    const residents = [...this.residentTargets];
    if (residents.length <= this.maxResidentValue) return;
    residents
      .sort((a, b) => {
        const visible = Number(b.classList.contains("visible")) - Number(a.classList.contains("visible"));
        if (visible !== 0) return visible;
        const aUnreadAt = unreadAt.get(a.dataset.workspaceId ?? "");
        const bUnreadAt = unreadAt.get(b.dataset.workspaceId ?? "");
        if (aUnreadAt !== undefined && bUnreadAt !== undefined) return aUnreadAt - bUnreadAt;
        if (aUnreadAt !== undefined) return -1;
        if (bUnreadAt !== undefined) return 1;
        return Number(b.dataset.lastActivatedAt ?? 0) - Number(a.dataset.lastActivatedAt ?? 0);
      })
      .slice(this.maxResidentValue)
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
 * Owns all per-client list state: which row is visible and the optimistic
 * pending-delete feedback. Broadcast HTML from the server never carries this.
 */
class WorkspaceListController extends Controller {
  static targets = ["status"];
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
    link.blur();
    const workspaceId = row.dataset.workspaceId;
    if (workspaceId) void residencyController()?.selectWorkspace(workspaceId, link.href);
    this.markVisible(workspaceId);
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
      this.markVisible(workspaceId);
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
    if (workspaceId) void residencyController()?.selectWorkspace(workspaceId, link.href);
    this.markVisible(workspaceId);
  }

  markVisibleWorkspace(workspaceId: string): void {
    this.markVisible(workspaceId);
  }

  statusTargetConnected(status: HTMLElement): void {
    const row = status.closest<HTMLElement>(".workspace-row[data-workspace-id]");
    const workspaceId = row?.dataset.workspaceId;
    if (workspaceId) this.setStatusPreloading(status, residencyController()?.isWorkspacePreloading(workspaceId) ?? false);
    residencyController()?.reconcileResidents();
  }

  setWorkspacePreloading(workspaceId: string, preloading: boolean): void {
    const status = this.element.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"] .workspace-status`);
    if (status) this.setStatusPreloading(status, preloading);
  }

  private setStatusPreloading(status: HTMLElement, preloading: boolean): void {
    status.toggleAttribute("data-workspace-preloading", preloading);
    const spinner = status.querySelector(":scope > .workspace-preload-spinner");
    if (preloading && !spinner) status.insertAdjacentHTML("beforeend", `<span class="status-spinner sm workspace-preload-spinner" aria-label="Preloading workspace" title="Preloading workspace"></span>`);
    if (!preloading) spinner?.remove();
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
    this.markVisible(workspaceId);
    void residencyController()?.selectWorkspace(workspaceId, href);
  }

  deleteClicked(event: Event): void {
    // The row itself is clickable; keep a delete-button click from also
    // selecting the workspace while allowing the form submission to proceed.
    event.stopPropagation();
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
    return residencyController()?.visibleWorkspaceId();
  }

  private markVisible(workspaceId: string | undefined): void {
    this.element.querySelectorAll<HTMLElement>(".workspace-row.visible").forEach((row) => row.classList.remove("visible"));
    if (!workspaceId) {
      return;
    }
    this.element.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"]`)?.classList.add("visible");
  }

  private sync(): void {
    const residency = residencyController();
    const workspaceId = this.currentWorkspaceId();
    if (!workspaceId) {
      this.markVisible(undefined);
      return;
    }
    const row = this.element.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"]`);
    if (!row) {
      // The workspace we were looking at disappeared (deleted here or elsewhere).
      residency?.removeWorkspace(workspaceId);
      if (location.pathname === `/workspaces/${encodeURIComponent(workspaceId)}`) history.replaceState({}, "", "/");
      this.markVisible(undefined);
      return;
    }
    this.markVisible(workspaceId);
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
    if (isWorkspacePaneVisible(this.element)) this.load();
  }

  disconnect(): void {
    document.removeEventListener("atelier:theme-change", this.themeChanged);
  }

  becomeVisible(): void {
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
  declare readonly element: HTMLElement;
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
    const visibleTargets = ["auth", "progress", "prompt"].filter((target) => this.element.querySelector<HTMLElement>(`[data-oauth-progress-reveal-target~="${target}"]:not([hidden])`));
    if (this.element.dataset.oauthPromptRequested === "true" && !visibleTargets.includes("prompt")) visibleTargets.push("prompt");
    const codeCopied = this.element.dataset.oauthCodeCopied === "true";
    const html = await response.text();
    window.Turbo?.renderStreamMessage(html);
    if (visibleTargets.length || codeCopied) {
      window.requestAnimationFrame(() => {
        const dialog = document.querySelector<HTMLElement>("#settings_flow_dialog");
        for (const target of visibleTargets) dialog?.querySelectorAll<HTMLElement>(`[data-oauth-progress-reveal-target~="${target}"]`).forEach((item) => { item.hidden = false; });
        if (visibleTargets.includes("prompt")) dialog?.setAttribute("data-oauth-prompt-requested", "true");
        if (codeCopied) {
          dialog?.setAttribute("data-oauth-code-copied", "true");
          const copyButton = dialog?.querySelector<HTMLButtonElement>('[data-oauth-copy-button="true"]');
          if (copyButton) copyButton.textContent = "Copied ✓";
        }
      });
    }
  }
}

class OAuthProgressRevealController extends Controller {
  static targets = ["auth", "progress", "prompt"];
  declare readonly authTargets: HTMLElement[];
  declare readonly progressTargets: HTMLElement[];
  declare readonly promptTargets: HTMLElement[];

  showAuth(): void {
    this.element.closest<HTMLElement>("#settings_flow_dialog")?.setAttribute("data-oauth-code-copied", "true");
    for (const item of this.authTargets) item.hidden = false;
  }

  showProgress(): void {
    for (const item of this.progressTargets) item.hidden = false;
  }

  showPrompt(): void {
    this.element.closest<HTMLElement>("#settings_flow_dialog")?.setAttribute("data-oauth-prompt-requested", "true");
    for (const item of this.promptTargets) item.hidden = false;
  }
}

class SettingsAutosaveController extends Controller {
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
    this.paneTargets.forEach((pane, paneIndex) => pane.classList.toggle("visible", paneIndex === this.index));
    this.dotTargets.forEach((dot, dotIndex) => dot.classList.toggle("visible", dotIndex === this.index));
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

function agentModelLabelHtml(provider: string, label: string): string {
  return `${providerBrandIconHtml(provider, label, "brand-icon agent-model-provider-icon")}<span>${escapeHtml(label)}</span>`;
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
    this.element.addEventListener("change", this.sync);
    this.form = this.element.form;
    this.form?.addEventListener("submit", this.submit, true);
    document.addEventListener("click", this.closeFromOutside);
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["selected", "disabled"] });
    this.sync();
  }

  disconnect(): void {
    this.button?.removeEventListener("click", this.toggle);
    this.element.removeEventListener("change", this.sync);
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
    const selectedLabel = selected?.textContent?.trim() || "Select model";
    this.button.innerHTML = this.hasAvailableModel()
      ? agentModelLabelHtml(selected?.dataset.provider ?? "", selectedLabel)
      : "Configure favorite models";
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
      label.className = "agent-model-option-label";
      label.innerHTML = agentModelLabelHtml(option.dataset.provider ?? "", option.textContent ?? option.value);
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
    await copyTextToClipboard(text);
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : undefined;
    const original = button?.textContent ?? "Copy to clipboard";
    if (button) {
      this.element.closest<HTMLElement>("#settings_flow_dialog")?.setAttribute("data-oauth-code-copied", "true");
      button.textContent = button.classList.contains("icon") ? "✓" : "Copied ✓";
      if (button.dataset.oauthCopyButton !== "true") window.setTimeout(() => { button.textContent = original; }, 3000);
    }
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

const ProjectGithubSearchController = createHtmlAutocompleteController(Controller, {
  optionSelector: ".agent-completion-option",
  loadingHtml: `<div class="agent-completion-menu empty"><span class="agent-completion-spinner" aria-hidden="true"></span>Searching GitHub…</div>`,
  request(input) {
    const query = input.value.trim();
    if (query.length < 2 || looksLikeProjectSpec(query)) return undefined;
    return { query, debounceMs: 200 };
  },
  select(option, input) {
    const gitUrl = option.dataset.gitUrl;
    if (!gitUrl) return;
    input.value = gitUrl;
    input.setSelectionRange(gitUrl.length, gitUrl.length);
  },
});

window.AtelierCable ??= createAtelierCableClient();

class CableShellController extends Controller {
  connect(): void {
    window.AtelierCable?.subscribe(CableTopics.shell());
  }
}

class DevReloadController extends Controller {
  static values = { url: String };

  declare readonly urlValue: string;

  private revision: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;

  connect(): void {
    this.connected = true;
    void this.poll();
  }

  disconnect(): void {
    this.connected = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetch(this.urlValue, { cache: "no-store" });
      if (response.ok) {
        const value = await response.json() as { revision?: unknown };
        if (typeof value.revision === "number") {
          if (this.revision !== undefined && value.revision !== this.revision) {
            window.location.reload();
            return;
          }
          this.revision = value.revision;
        }
      }
    } catch {
      // Server restarts temporarily make the development endpoint unavailable.
    }
    if (this.connected) this.timer = setTimeout(() => void this.poll(), 1_000);
  }
}

const application = Application.start();
for (const module of workspaceClientModules) await module.install({ application, Controller, hooks: clientHooks });
application.register("cable-shell", CableShellController);
application.register("dev-reload", DevReloadController);
application.register("workspace-shell", WorkspaceShellController);
application.register("workspace-tabs", WorkspaceTabsController);
application.register("workspace-tab-close", WorkspaceTabCloseController);
application.register("workspace-groups", WorkspaceGroupsController);
application.register("workspace-command-form", WorkspaceCommandFormController);
application.register("workspace-residency", WorkspaceResidencyController);
application.register("atelier-shortcuts", AtelierShortcutsController);
application.register("atelier-fullscreen", AtelierFullscreenController);
application.register("submit-shortcut", SubmitShortcutController);
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("agent-launch-dialog", AgentLaunchDialogController);
application.register("project-github-search", ProjectGithubSearchController);
application.register("workspace-list", WorkspaceListController);
application.register("workspace-title-edit", WorkspaceTitleEditController);
application.register("provision-terminal", createProvisionTerminalController(Controller));
application.register("auto-scroll", AutoScrollController);
application.register("workspace-app-frame", WorkspaceAppFrameController);
application.register("theme-select", ThemeSelectController);
application.register("oauth-flow", OAuthFlowController);
application.register("oauth-progress-reveal", OAuthProgressRevealController);
application.register("git-identity", GitIdentityController);
application.register("settings-autosave", SettingsAutosaveController);
application.register("settings-checkbox", SettingsAutosaveController);
application.register("provider-list", ProviderListController);
application.register("model-add-menu", ModelAddMenuController);
application.register("onboarding", OnboardingController);
application.register("clipboard", ClipboardController);
application.register("agent-select-menu", AgentSelectMenuController);
application.register("agent-model-menu", AgentModelMenuController);

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/service-worker.js");
}
