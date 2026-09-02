/// <reference lib="dom" />

import { Application as StimulusApplication, Controller as StimulusController } from "@hotwired/stimulus";
import { Type } from "typebox";
import { Value } from "typebox/value";
// Turbo does not publish TypeScript declarations, but Bun resolves and bundles its browser module.
// @ts-expect-error No declaration file is included in @hotwired/turbo.
import * as Turbo from "@hotwired/turbo";
import { createHtmlAutocompleteController, PromptHistoryNavigator } from "@atelier/agent/client";
import { actionItemElement, actionItemHtml } from "@atelier/design-system/action-item";
import { autocompleteHtml } from "@atelier/design-system/autocomplete";
import { buttonHtml } from "@atelier/design-system/button";
import { Icons } from "@atelier/design-system/icons";
import { showTransientFeedback } from "@atelier/design-system/transient-feedback/client";
import {
  atelierCableConnectionHeader,
  CableTopics,
  composerSubmitKey,
  copyTextToClipboard,
  escapeHtml,
  focusLikelyOpensSoftwareKeyboard,
  installSoftwareKeyboardTracking,
  looksLikeProjectSpec,
  isWorkspacePaneVisible,
  phoneViewportMediaQuery,
  recentWorkspaceProjectStorageKey,
  workspaceProxyUrl,
  type AtelierCableClient,
  type WorkspaceClientSurfaceVisibilityContext,
  type WorkspaceClientHooks,
  type WorkspaceClientControllerConstructor,
  type WorkspaceClientWorkspaceAppFrameContext,
  type WorkspaceClientCommand,
  type WorkspacePaletteItem,
  type WorkspacePaletteProvider,
  type WorkspacePaletteSearchContext,
} from "@atelier/shared";
import { createProvisionTerminalController } from "@atelier/workspace/client";
import { workspaceClientModules } from "./workspace-client-modules.generated.ts";
import { createAtelierCableClient } from "./cable.ts";
import { createCloseButton, registerDesignSystemControllers } from "./design-system.ts";
import { createWorkspacePresentationController, installWorkspacePresentationTurboStream, markActiveWorkspaceRow } from "./workspace-presentation.ts";
import { oldestAttentionFirst, prioritizedWorkspacePreloads, retainedWorkspaceIds, type AttentionWorkspace, type WorkspacePreloadCandidate, type WorkspaceRetentionCandidate } from "./workspace-residency-policy.ts";

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
  // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
  Application: StimulusApplication as typeof window.Stimulus.Application,
  // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
  Controller: StimulusController as typeof window.Stimulus.Controller,
};
window.Turbo = Turbo;

const { Application, Controller } = window.Stimulus;
const workspaceBusyViewsSchema = Type.Array(Type.String());
const workspaceAttentionTokensSchema = Type.Record(Type.String(), Type.Integer({ minimum: 1 }));

class WorkspaceClientHookRegistry implements WorkspaceClientHooks {
  private readonly becomeVisibleHandlers: Array<(context: WorkspaceClientSurfaceVisibilityContext) => void> = [];
  private readonly noLongerVisibleHandlers: Array<(context: WorkspaceClientSurfaceVisibilityContext) => void> = [];
  private readonly workspaceAppFrameUrlHandlers: Array<(context: WorkspaceClientWorkspaceAppFrameContext) => void> = [];
  private readonly workspaceAppFrameRefreshHandlers: Array<(context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void> = [];
  private readonly paletteProviders = new Map<string, WorkspacePaletteProvider>();
  private readonly commands = new Map<string, WorkspaceClientCommand>();

  onBecomeVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void { this.becomeVisibleHandlers.push(handler); }
  onNoLongerVisible(handler: (context: WorkspaceClientSurfaceVisibilityContext) => void): void { this.noLongerVisibleHandlers.push(handler); }
  onWorkspaceAppFrameUrl(handler: (context: WorkspaceClientWorkspaceAppFrameContext) => void): void { this.workspaceAppFrameUrlHandlers.push(handler); }
  onWorkspaceAppFrameRefresh(handler: (context: { appKey: string; frame: HTMLIFrameElement; load(): void }) => void): void { this.workspaceAppFrameRefreshHandlers.push(handler); }
  registerPaletteProvider(provider: WorkspacePaletteProvider): void { this.paletteProviders.set(provider.id, provider); }
  registerCommand(command: WorkspaceClientCommand): void { this.commands.set(command.id, command); }
  registeredCommands(): WorkspaceClientCommand[] { return [...this.commands.values()]; }

  becomeVisible(context: WorkspaceClientSurfaceVisibilityContext): void {
    this.becomeVisibleHandlers.forEach((handler) => handler(context));
  }

  noLongerVisible(context: WorkspaceClientSurfaceVisibilityContext): void {
    this.noLongerVisibleHandlers.forEach((handler) => handler(context));
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
      return items.map((item) => ({ ...item, score: item.score ?? this.paletteItemScore(query, item) }));
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

type PaletteResult = WorkspacePaletteItem & { score: number };

const clientHooks = new WorkspaceClientHookRegistry();

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

type FullscreenMode = "view" | "template" | "media";
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
  static values = { mode: String, viewKey: String, title: String };
  declare readonly element: HTMLElement;
  declare readonly modeValue: FullscreenMode;
  declare readonly viewKeyValue: string;
  declare readonly titleValue: string;
  private iframeLoadTargets: HTMLIFrameElement[] = [];
  private readonly pointerenter = (): void => pushFullscreenHover(this);
  private readonly pointerleave = (): void => removeFullscreenHover(this);
  private readonly iframeLoaded = (event: Event): void => {
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
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

    if (this.modeValue === "view") this.openLiveView();
    else this.openViewer();
  }

  private openLiveView(): void {
    this.showView();
    const target = this.liveViewTarget();
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
    const surface = document.createElement("div");
    surface.className = "atelier-fullscreen-surface";
    let session: FullscreenSession;
    const close = (): void => dialog.close();
    surface.append(this.createBar(close), viewer.element);
    dialog.append(surface);
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
    bar.className = "atelier-fullscreen-bar work-view-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Fullscreen controls");

    const title = document.createElement("strong");
    title.className = "atelier-fullscreen-title";
    title.textContent = this.titleValue;
    const close = createCloseButton("Exit full screen");
    close.addEventListener("click", closeFullscreen);
    bar.append(title, close);
    return bar;
  }

  private liveViewTarget(): HTMLElement {
    return this.element.closest<HTMLElement>(".fixed-workspace-presentation")!.querySelector<HTMLElement>(`[data-atelier-fullscreen-view-key="${CSS.escape(this.viewKeyValue)}"]`)!;
  }

  private showView(): void {
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
    (this.element as HTMLButtonElement).click();
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

type CommandRegistration = WorkspaceClientCommand;
type WorkspaceCommandRegistration = Omit<WorkspaceClientCommand, "run">;

class AtelierShortcutsController extends Controller {
  declare readonly element: HTMLElement;
  private shortcutOverlayTimer: ReturnType<typeof setTimeout> | undefined;
  private shortcutOverlay: HTMLElement | undefined;
  private shortcutOverlayPointerInside = false;
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
      search: ({ fuzzyScore }) => this.workspacePaletteItems(fuzzyScore),
    });
    clientHooks.registerPaletteProvider({
      id: "atelier.destinations",
      search: ({ fuzzyScore }) => this.workspaceDestinationPaletteItems(fuzzyScore),
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
    if (!event.metaKey || !event.altKey || event.ctrlKey) return;

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
    if ((!event.metaKey || !event.altKey) && !this.shortcutOverlayPointerInside) this.hideShortcutOverlay();
  };

  private readonly shortcutBlur = (): void => {
    this.hideShortcutOverlay();
  };

  private registerBuiltinCommands(): void {
    clientHooks.registerCommand({
      id: "workspace.open-previous",
      label: "Open previous workspace",
      scope: "global",
      binding: "Meta+Alt+Comma",
      run: () => this.openAdjacentWorkspace(-1),
    });
    clientHooks.registerCommand({
      id: "workspace.open-next",
      label: "Open next workspace",
      scope: "global",
      binding: "Meta+Alt+Period",
      run: () => this.openAdjacentWorkspace(1),
    });
    clientHooks.registerCommand({
      id: "workspace.open-oldest-unread",
      label: "Open oldest workspace needing attention",
      scope: "global",
      binding: "Meta+Alt+Slash",
      run: () => this.openOldestAttentionWorkspace(),
    });
    clientHooks.registerCommand({
      id: "work-view.open-previous",
      label: "Open previous Work view",
      scope: "workspace",
      binding: "Meta+Alt+BracketLeft",
      run: () => this.openAdjacentWorkView(-1),
    });
    clientHooks.registerCommand({
      id: "work-view.open-next",
      label: "Open next Work view",
      scope: "workspace",
      binding: "Meta+Alt+BracketRight",
      run: () => this.openAdjacentWorkView(1),
    });
    clientHooks.registerCommand({
      id: "atelier.open-palette",
      label: "Open palette",
      scope: "global",
      binding: "Meta+Alt+KeyK",
      run: () => this.openPalette(),
    });
    clientHooks.registerCommand({
      id: "atelier.open-settings",
      label: "Open settings",
      scope: "global",
      run: () => this.openSettingsDialog(),
    });
  }

  private currentCommands(): CommandRegistration[] {
    const commands = new Map<string, CommandRegistration>(
      clientHooks.registeredCommands().map((command) => [command.id, command] as const),
    );
    for (const command of this.visibleWorkspaceDeleteCommands()) commands.set(command.id, command);
    for (const command of this.workspaceCommands()) {
      if (!commands.has(command.id)) {
        commands.set(command.id, {
          ...command,
          run: () => this.executeVisibleWorkspaceCommand(command.id),
        });
      }
    }
    return [...commands.values()];
  }

  private visibleWorkspaceDeleteCommands(): CommandRegistration[] {
    if (!this.visibleWorkspaceDeleteForm()) return [];
    return [{
      id: "workspace.delete",
      label: "Delete workspace",
      description: "Delete the current workspace",
      scope: "workspace",
      binding: "Meta+Alt+Backspace",
      run: () => this.deleteVisibleWorkspace(),
    }, {
      id: "workspace.force-delete",
      label: "Force delete workspace",
      description: "Delete the current workspace without checking for outstanding changes",
      scope: "workspace",
      binding: "Meta+Alt+Shift+Backspace",
      run: () => this.deleteVisibleWorkspace(true),
    }];
  }

  private visibleWorkspaceDeleteForm(): HTMLFormElement | null {
    const workspaceId = this.visibleWorkspaceId();
    if (!workspaceId) return null;
    const action = `/workspaces/${CSS.escape(workspaceId)}/delete`;
    return document.querySelector<HTMLFormElement>(`.workspace-detail-resident.visible form.fixed-shell-delete-workspace[action="${action}"]`);
  }

  private deleteVisibleWorkspace(force = false): void {
    const form = this.visibleWorkspaceDeleteForm();
    if (!form) return;
    const workspaceId = this.visibleWorkspaceId()!;
    if (force) {
      const submitter = document.createElement("button");
      submitter.type = "submit";
      submitter.hidden = true;
      const action = new URL(form.action);
      action.searchParams.set("force", "1");
      submitter.formAction = action.href;
      form.append(submitter);
      form.requestSubmit(submitter);
      submitter.remove();
    } else {
      submitFormWithFirstButton(form);
    }
    residencyController()?.unselectWorkspace(workspaceId);
  }

  private visibleWorkspacePresentation(): HTMLElement | null {
    return document.querySelector(".workspace-detail-resident.visible .fixed-workspace-presentation");
  }

  private workspaceCommands(): WorkspaceCommandRegistration[] {
    const presentation = this.visibleWorkspacePresentation();
    if (presentation) {
      // SAFETY: The server renders this dataset from WorkspaceCommandRegistration values.
      return JSON.parse(presentation.dataset.workspaceCommands!) as WorkspaceCommandRegistration[];
    }
    return [];
  }

  private openAdjacentWorkView(direction: -1 | 1): void {
    const presentation = this.visibleWorkspacePresentation();
    if (!presentation) return;
    if (!presentation.classList.contains("is-work-pane-open")) {
      presentation.querySelector<HTMLButtonElement>("[data-show-work-pane]")?.click();
      return;
    }

    const selectors = [...presentation.querySelectorAll<HTMLButtonElement>("[data-work-view-key]")];
    const activeIndex = selectors.findIndex((selector) => selector.getAttribute("aria-selected") === "true");
    if (activeIndex < 0 || selectors.length < 2) return;
    selectors[(activeIndex + direction + selectors.length) % selectors.length]!.click();
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
    this.shortcutOverlayPointerInside = false;
  };

  private showShortcutOverlay(): void {
    const commands = this.currentCommands()
      .filter((command): command is CommandRegistration & { binding: string } => Boolean(command.binding))
      .sort((a, b) => a.label.localeCompare(b.label));

    const overlay = document.createElement("aside");
    overlay.className = "shortcut-overlay floating-surface viewport-overlay";
    overlay.setAttribute("role", "region");
    overlay.setAttribute("aria-labelledby", "shortcut-overlay-title");
    overlay.setAttribute("aria-live", "polite");
    overlay.addEventListener("pointerenter", () => { this.shortcutOverlayPointerInside = true; });
    overlay.addEventListener("pointerleave", this.hideShortcutOverlay);

    const title = document.createElement("h2");
    title.id = "shortcut-overlay-title";
    title.className = "shortcut-overlay-title";
    title.textContent = "Keyboard shortcuts";
    overlay.append(title);

    const separator = document.createElement("hr");
    separator.className = "shortcut-overlay-separator";
    overlay.append(separator);

    const actions = document.createElement("div");
    actions.className = "action-list";
    for (const command of commands) {
      const button = actionItemElement<HTMLButtonElement>({
        kind: "single",
        label: { kind: "text", text: command.label },
        trailingHtml: `<kbd class="shortcut-overlay-binding">${escapeHtml(this.formatBinding(command.binding))}</kbd>`,
        element: { tag: "button", className: "shortcut-overlay-item", attributesHtml: 'type="button"' },
      });
      button.addEventListener("click", () => {
        this.hideShortcutOverlay();
        void command.run();
      });
      actions.append(button);
    }
    overlay.append(actions);

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
        case "Backslash": return "\\";
        case "Backspace": return "⌫";
        case "BracketLeft": return "[";
        case "BracketRight": return "]";
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
      case "BracketLeft": return event.key === "[";
      case "BracketRight": return event.key === "]";
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
    dialog.className = "dialog palette-dialog";
    dialog.setAttribute("aria-label", "Command palette");
    dialog.innerHTML = `<header class="palette-search">
      <svg class="palette-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m16 16 4 4"></path></svg>
      <input class="text-field palette-input" id="atelier-palette-input" type="search" role="combobox" spellcheck="false" autocomplete="off" placeholder="Search commands, workspaces, and destinations…" aria-label="Search command palette" aria-autocomplete="list" aria-controls="atelier-palette-results" aria-expanded="true">
      <kbd class="palette-shortcut" aria-hidden="true">⌘⌥K</kbd>
      <form class="contents" method="dialog">${buttonHtml({ type: "submit", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.Close, label: "Close command palette" }, attributesHtml: "data-palette-close" })}</form>
    </header>
    <div class="dialog__body palette-body"><div class="palette-results action-list" id="atelier-palette-results" role="listbox" aria-label="Command palette results"></div></div>`;
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
      this.paletteInput!.removeAttribute("aria-activedescendant");
      results.innerHTML = `<div class="empty-state palette-empty"><strong>No results found</strong><span>Try another command, workspace, or destination.</span></div>`;
      return;
    }
    results.innerHTML = this.paletteItems.map((item, index) => actionItemHtml({
      kind: "single",
      label: { kind: "text", text: item.title },
      trailingHtml: item.badge ? `<kbd class="palette-item-meta">${escapeHtml(item.badge)}</kbd>` : "",
      element: { tag: "button", attributesHtml: `id="atelier-palette-option-${index}" type="button" data-palette-index="${index}" role="option" aria-selected="${index === this.paletteIndex ? "true" : "false"}"` },
    })).join("");
    const activeId = `atelier-palette-option-${this.paletteIndex}`;
    this.paletteInput!.setAttribute("aria-activedescendant", activeId);
    results.querySelector<HTMLElement>(`#${activeId}`)?.scrollIntoView({ block: "nearest" });
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
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-palette-index]") : null;
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
      const workspaceId = row.dataset.workspaceEntryId!;
      const title = row.title || workspaceId;
      const parked = Boolean(row.closest(".fixed-shell-parked"));
      const visible = row.classList.contains("active");
      const matchScore = fuzzyScore(`${title} ${workspaceId} ${parked ? "parked" : ""}`);
      return {
        id: `workspace:${workspaceId}`,
        title,
        subtitle: parked ? "Parked workspace" : "Workspace",
        badge: visible ? "open" : undefined,
        keywords: [workspaceId, parked ? "parked" : ""],
        score: matchScore > 0 ? matchScore + (visible ? 15 : 0) - (parked ? 8 : 0) : 0,
        run: () => this.openWorkspaceRow(row),
      };
    });
  }

  private workspaceDestinationPaletteItems(fuzzyScore: (candidate: string) => number): WorkspacePaletteItem[] {
    const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.visible[data-workspace-id]");
    if (!resident) return [];
    const workspaceId = resident.dataset.workspaceId!;
    return [...resident.querySelectorAll<HTMLButtonElement>("[data-work-view-key], [data-agent-conversation-id]")].map((destination) => {
      const key = destination.dataset.workViewKey ?? destination.dataset.agentConversationId!;
      const label = destination.textContent?.trim() || key;
      const visible = destination.getAttribute("aria-selected") === "true";
      const matchScore = fuzzyScore(`${label} ${key}`);
      return {
        id: `destination:${workspaceId}:${key}`,
        title: label,
        subtitle: destination.dataset.agentConversationId ? "Agent conversation" : "Work view",
        badge: visible ? "open" : undefined,
        keywords: [key],
        score: matchScore > 0 ? matchScore + (visible ? 20 : 0) : 0,
        run: () => destination.click(),
      };
    });
  }

  private workspaceRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".fixed-shell-workspace-row[data-workspace-entry-id]")];
  }

  private async openWorkspaceRow(row: HTMLElement): Promise<void> {
    const workspaceId = row.dataset.workspaceEntryId;
    if (workspaceId) await workspaceNavigationController()?.selectWorkspaceById(workspaceId);
  }

  private async openSettingsDialog(): Promise<void> {
    const response = await fetch("/settings", { headers: { "Accept": "text/vnd.turbo-stream.html" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (html) window.Turbo?.renderStreamMessage(html);
  }

  private visibleWorkspaceId(): string | undefined {
    return document.querySelector<HTMLElement>(".fixed-shell-workspace-row.active[data-workspace-entry-id]")?.dataset.workspaceEntryId
      ?? residencyController()?.visibleWorkspaceId();
  }

  async openOldestAttentionWorkspace(): Promise<void> {
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
    await workspaceNavigationController()?.selectWorkspaceById(workspaceId);
  }

  private async openAdjacentWorkspace(direction: -1 | 1): Promise<void> {
    const rows = this.workspaceRows().filter((row) => !row.closest(".fixed-shell-parked"));
    if (rows.length === 0) return;
    const currentWorkspaceId = this.visibleWorkspaceId();
    const currentIndex = rows.findIndex((row) => row.dataset.workspaceEntryId === currentWorkspaceId);
    const targetIndex = currentIndex < 0
      ? (direction > 0 ? 0 : rows.length - 1)
      : (currentIndex + direction + rows.length) % rows.length;
    const row = rows[targetIndex];
    if (row && row.dataset.workspaceEntryId !== currentWorkspaceId) await this.openWorkspaceRow(row);
  }

  private async executeVisibleWorkspaceCommand(commandId: string): Promise<void> {
    const workspaceId = this.visibleWorkspaceId();
    if (!workspaceId) return;
    try {
      const response = await fetch(`/workspaces/${encodeURIComponent(workspaceId)}/commands/${encodeURIComponent(commandId)}`, {
        method: "POST",
        headers: cableRequestHeaders({ "Accept": "text/vnd.turbo-stream.html" }),
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
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function submitFormWithFirstButton(form: HTMLFormElement): void {
  const submitter = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
  form.requestSubmit(submitter ?? undefined);
}

class SubmitShortcutController extends Controller {
  private submitting = false;

  keydown(event: KeyboardEvent): void {
    if (!composerSubmitKey(event)) return;
    event.preventDefault();
    if (this.submitting) return;
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
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
    if (activeElement && this.element.contains(activeElement)) activeElement.blur();
  };

  connect(): void {
    this.element.addEventListener("close", this.onClose);
    if (this.autoShowValue && !this.element.open) {
      this.element.showModal();
      if (this.element.autofocus) this.element.focus();
      else focusDialogPromptEnd(this.element);
    }
  }

  disconnect(): void {
    this.element.removeEventListener("close", this.onClose);
  }

  close(): void {
    this.element.close();
  }

  submitted(event: Event): void {
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
    const detail = (event as CustomEvent).detail as { success?: boolean } | undefined;
    if (detail?.success === false) return;
    this.element.close();
  }
}

const launchComposerPromptHistoryStorageKey = "atelier:launch-composer-prompt-history";
const launchComposerPromptHistorySchema = Type.Array(Type.String());

class LaunchComposerDialogController extends Controller {
  static values = { discardUrl: String };
  declare readonly element: HTMLDialogElement;
  declare readonly discardUrlValue: string;
  private submitted = false;
  private readonly promptHistoryNavigator = new PromptHistoryNavigator();

  connect(): void {
    this.element.addEventListener("click", this.clicked);
    this.element.addEventListener("close", this.closed);
    this.input.addEventListener("keydown", this.inputKeydown);
    this.input.addEventListener("input", this.inputChanged);
    this.element.showModal();
    if (focusLikelyOpensSoftwareKeyboard()) {
      if (document.activeElement === this.input) this.input.blur();
    } else {
      focusDialogPromptEnd(this.element);
    }
  }

  disconnect(): void {
    this.element.removeEventListener("click", this.clicked);
    this.element.removeEventListener("close", this.closed);
    this.input.removeEventListener("keydown", this.inputKeydown);
    this.input.removeEventListener("input", this.inputChanged);
  }

  private get input(): HTMLTextAreaElement {
    return this.element.querySelector<HTMLTextAreaElement>('textarea[name="text"]')!;
  }

  private promptHistory(): string[] {
    const value = localStorage.getItem(launchComposerPromptHistoryStorageKey);
    return value ? Value.Parse(launchComposerPromptHistorySchema, JSON.parse(value)) : [];
  }

  private readonly inputKeydown = (event: KeyboardEvent): void => {
    this.promptHistoryNavigator.keydown(event, this.input, () => this.promptHistory());
  };

  private readonly inputChanged = (): void => {
    this.promptHistoryNavigator.inputChanged();
  };

  private readonly clicked = (event: MouseEvent): void => {
    if (!window.matchMedia(phoneViewportMediaQuery).matches || event.target !== this.element) return;
    const bounds = this.element.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) this.element.close();
  };

  submit(): void {
    const prompt = this.input.value;
    if (prompt.trim()) localStorage.setItem(launchComposerPromptHistoryStorageKey, JSON.stringify([...this.promptHistory(), prompt]));
    // Intentionally only dismiss the LaunchComposer here: do not select or wait for the launched Workspace.
    this.submitted = true;
    this.element.close();
  }

  private readonly closed = (): void => {
    if (this.submitted) return;
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
    // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
    const dialog = document.getElementById(this.targetIdValue) as HTMLDialogElement | null;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    this.element.blur();
    focusDialogPromptEnd(dialog);
  }
}

const projectDisclosuresSchema = Type.Record(Type.String(), Type.Boolean());

class EmptyWorkspaceOnboardingController extends Controller {
  static targets = ["origin", "svg", "path"];
  static values = { destination: String };

  declare readonly element: HTMLElement;
  declare readonly originTarget: HTMLElement;
  declare readonly svgTarget: SVGSVGElement;
  declare readonly pathTarget: SVGPathElement;
  declare readonly destinationValue: "first-project" | "first-workspace";

  private observer: MutationObserver | undefined;

  connect(): void {
    window.addEventListener("resize", this.draw);
    const empty = this.element.closest(".workspace-detail-empty")!;
    this.observer = new MutationObserver(this.draw);
    this.observer.observe(empty, { attributes: true, attributeFilter: ["hidden"] });
    this.observer.observe(this.element.closest(".fixed-shell-app")!, { attributes: true, attributeFilter: ["class"] });
    requestAnimationFrame(this.draw);
  }

  disconnect(): void {
    window.removeEventListener("resize", this.draw);
    this.observer?.disconnect();
  }

  private draw = (): void => {
    const origin = this.originTarget.getBoundingClientRect();
    if (origin.width === 0) return;
    const start = { x: origin.left + origin.width / 2, y: origin.bottom + 12 };
    const app = this.element.closest(".fixed-shell-app")!;
    const isPhone = window.matchMedia(phoneViewportMediaQuery).matches;
    const workspacePaneOpen = app.classList.contains("is-mobile-workspace-pane-open");
    const pointToMobileNavigation = isPhone && !workspacePaneOpen;
    const destinationSelector = pointToMobileNavigation
      ? "[data-mobile-workspace-destination]"
      : `[data-empty-workspace-onboarding-destination="${this.destinationValue}"]`;
    const destination = document.querySelector<HTMLElement>(destinationSelector)!.getBoundingClientRect();
    const end = { x: isPhone && workspacePaneOpen ? destination.left - 5 : destination.right + 5, y: destination.top + destination.height / 2 };
    const horizontalDirection = end.x >= start.x ? 1 : -1;
    const horizontalBend = Math.min(180, Math.max(40, Math.abs(end.x - start.x) * 0.7));
    const verticalBend = Math.min(150, Math.max(70, Math.abs(end.y - start.y) * 0.45));
    this.svgTarget.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    this.pathTarget.setAttribute("d", `M ${start.x} ${start.y} C ${start.x} ${start.y + verticalBend}, ${end.x - horizontalDirection * horizontalBend} ${end.y}, ${end.x} ${end.y}`);
  };
}

class WorkspaceNavigationController extends Controller {
  static targets = ["scroll"];
  declare readonly element: HTMLElement;
  declare readonly scrollTarget: HTMLElement;
  private scrollTimer?: ReturnType<typeof setTimeout>;

  connect(): void {
    this.scrollTarget.addEventListener("scroll", this.scrolled, { passive: true });
    this.element.addEventListener("atelier:mobile-resident-destination-selected", this.mobileResidentDestinationSelected);
    document.addEventListener("atelier:workspace-pane-changed", this.workspacePaneChanged);
    const scroll = Number(localStorage.getItem("atelier:workspace-pane-scroll"));
    if (Number.isFinite(scroll)) this.scrollTarget.scrollTop = scroll;
    this.restoreProjectDisclosures();
    this.setWorkspacePaneOpen(!this.element.querySelector(".workspace-detail-resident.visible"));
    this.setWorkspacePaneCollapsed(sessionStorage.getItem("atelier:workspace-pane-collapsed") === "true" && Boolean(this.visibleWorkspacePaneToggle()));
  }

  disconnect(): void {
    this.scrollTarget.removeEventListener("scroll", this.scrolled);
    this.element.removeEventListener("atelier:mobile-resident-destination-selected", this.mobileResidentDestinationSelected);
    document.removeEventListener("atelier:workspace-pane-changed", this.workspacePaneChanged);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
  }

  toggleWorkspacePane(): void {
    this.setWorkspacePaneOpen(!this.element.classList.contains("is-mobile-workspace-pane-open"));
  }

  showWorkspacePane(): void {
    this.setWorkspacePaneOpen(true);
  }

  toggleWorkspacePaneCollapsed(): void {
    const collapsed = !this.element.classList.contains("is-workspace-pane-collapsed");
    const toggle = collapsed
      ? this.visibleWorkspacePaneToggle()
      : this.element.querySelector<HTMLButtonElement>("[data-collapse-workspace-pane]");
    if (!toggle) return;
    this.setWorkspacePaneCollapsed(collapsed);
    requestAnimationFrame(() => toggle.focus());
  }

  private setWorkspacePaneCollapsed(collapsed: boolean): void {
    this.element.classList.toggle("is-workspace-pane-collapsed", collapsed);
    sessionStorage.setItem("atelier:workspace-pane-collapsed", String(collapsed));
  }

  private visibleWorkspacePaneToggle(): HTMLButtonElement | null {
    return this.element.querySelector<HTMLButtonElement>(".workspace-detail-resident.visible [data-show-workspace-pane]");
  }

  private setWorkspacePaneOpen(open: boolean): void {
    this.element.classList.toggle("is-mobile-workspace-pane-open", open);
    const destination = this.element.querySelector<HTMLElement>("[data-mobile-workspace-destination]")!;
    const label = open ? "Hide Workspace pane" : "Show Workspace pane";
    destination.setAttribute("aria-label", label);
    destination.setAttribute("title", label);
    destination.setAttribute("aria-expanded", String(open));
    destination.setAttribute("aria-current", open ? "page" : "false");
  }

  private readonly mobileResidentDestinationSelected = (): void => this.setWorkspacePaneOpen(false);
  private readonly workspacePaneChanged = (): void => {
    this.restoreProjectDisclosures();
    const workspaceId = residencyController()?.visibleWorkspaceId();
    if (workspaceId) this.setActiveWorkspace(workspaceId);
  };

  async selectWorkspace(event: Event): Promise<void> {
    // SAFETY: This action is attached only to server-rendered Workspace entry elements.
    const workspaceId = (event.currentTarget as HTMLElement).dataset.workspaceEntryId;
    if (workspaceId) await this.selectWorkspaceById(workspaceId);
  }

  async selectWorkspaceById(workspaceId: string): Promise<void> {
    this.setWorkspacePaneOpen(false);
    this.setActiveWorkspace(workspaceId);
    await residencyController()?.selectWorkspace(workspaceId, `/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async parkWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    // SAFETY: This action is attached only to the server-rendered Agent-pane park form.
    const form = event.currentTarget as HTMLFormElement;
    await this.submitParkedState(form);
  }

  async unparkWorkspace(event: Event): Promise<void> {
    event.preventDefault();
    // SAFETY: This action is attached only to server-rendered unpark forms.
    const form = event.currentTarget as HTMLFormElement;
    const workspaceId = form.dataset.workspaceEntryId!;
    await this.submitParkedState(form);
    await this.selectWorkspaceById(workspaceId);
  }

  private async submitParkedState(form: HTMLFormElement): Promise<void> {
    const button = form.querySelector<HTMLButtonElement>("button[type='submit']")!;
    button.disabled = true;
    const response = await fetch(form.action, {
      method: "POST",
      headers: cableRequestHeaders({ Accept: "text/vnd.turbo-stream.html" }),
    });
    if (!response.ok) throw new Error(`Could not update parked workspace: HTTP ${response.status}`);
    const html = await response.text();
    if (html) window.Turbo?.renderStreamMessage(html);
  }

  toggleProject(event: Event): void {
    // SAFETY: This action is attached only to server-rendered Project disclosure buttons.
    const button = event.currentTarget as HTMLElement;
    const id = button.dataset.projectId;
    if (!id) return;
    const project = this.element.querySelector<HTMLElement>(`.fixed-shell-project[data-project-id="${CSS.escape(id)}"]`)!;
    const expanded = project.classList.contains("is-collapsed");
    project.classList.toggle("is-collapsed", !expanded);
    button.setAttribute("aria-expanded", String(expanded));
    const disclosures = this.projectDisclosures();
    disclosures[id] = expanded;
    localStorage.setItem("atelier:workspace-project-disclosures", JSON.stringify(disclosures));
  }

  setActiveWorkspace(workspaceId: string): void {
    markActiveWorkspaceRow(this.element, workspaceId);
    const row = this.element.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    localStorage.setItem(recentWorkspaceProjectStorageKey, row?.dataset.projectId ?? "");
  }

  private restoreProjectDisclosures(): void {
    const disclosures = this.projectDisclosures();
    this.element.querySelectorAll<HTMLElement>(".fixed-shell-project[data-project-id]").forEach((project) => {
      const onboardingTarget = project.querySelector('[data-empty-workspace-onboarding-destination="first-workspace"]');
      const id = project.dataset.projectId!;
      if (!(id in disclosures) && !onboardingTarget) return;
      const expanded = onboardingTarget ? true : disclosures[id]!;
      project.classList.toggle("is-collapsed", !expanded);
      project.querySelector<HTMLElement>(".fixed-shell-project-heading")?.setAttribute("aria-expanded", String(expanded));
    });
  }

  private projectDisclosures(): Record<string, boolean> {
    const text = localStorage.getItem("atelier:workspace-project-disclosures");
    return text ? Value.Parse(projectDisclosuresSchema, JSON.parse(text)) : {};
  }

  private scrolled = (): void => {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => localStorage.setItem("atelier:workspace-pane-scroll", String(this.scrollTarget.scrollTop)), 80);
  };
}

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

class WorkspaceResidencyController extends Controller {
  static targets = ["resident", "empty", "loading"];
  static values = { maxResident: Number };
  declare readonly element: HTMLElement;
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
    return presentation ? application.getControllerForElementAndIdentifier(presentation, "workspace-presentation") as WorkspaceSurfacePreparationController | null : null;
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
    const row = document.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
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
    const entry = document.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    if (!entry) return;
    entry.toggleAttribute("data-workspace-preloading", preloading);
    const attention = entry.querySelector<HTMLElement>(":scope > .workspace-attention-status");
    if (!attention) return;
    attention.setAttribute("aria-label", preloading ? "Attention; preparing workspace" : "Attention");
    attention.toggleAttribute("title", preloading);
    if (preloading) attention.title = "Preparing workspace";
  }

  private attentionWorkspaces(): AttentionWorkspace[] {
    return oldestAttentionFirst([...document.querySelectorAll<HTMLElement>(".fixed-shell-workspace-row[data-workspace-attention-at]")].map((entry) => ({
      workspaceId: entry.dataset.workspaceEntryId!,
      attentionAt: Number(entry.dataset.workspaceAttentionAt),
    })));
  }

  private preparationCandidates(): Array<{ workspaceId: string }> {
    const candidates = new Map<string, WorkspacePreloadCandidate>([...document.querySelectorAll<HTMLElement>(".fixed-shell-workspace-row[data-workspace-entry-id]")]
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
    const row = document.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
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
    document.querySelectorAll<HTMLElement>(".fixed-shell-workspace-row.active").forEach((row) => {
      row.classList.remove("active");
      row.removeAttribute("aria-current");
    });
    this.loadingTargets.forEach((loading) => { loading.hidden = true; });
    this.emptyTargets.forEach((empty) => { empty.hidden = false; });
  }

  private showLoading(workspaceId: string): void {
    this.setSwitchingWorkspace(true);
    this.hideResidents();
    this.emptyTargets.forEach((empty) => { empty.hidden = true; });
    const row = document.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
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
    const row = document.querySelector<HTMLElement>(`.fixed-shell-workspace-row[data-workspace-entry-id="${CSS.escape(workspaceId)}"]`);
    let serializedTokens = row?.dataset.workspaceAttentionTokens;
    if (!serializedTokens) return;
    if (window.matchMedia(phoneViewportMediaQuery).matches) {
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

function workspaceNavigationController(): WorkspaceNavigationController | null {
  const navigation = document.querySelector<HTMLElement>('[data-controller~="workspace-navigation"]');
  // SAFETY: The server-rendered shell and registered controller establish this element shape.
  return navigation ? application.getControllerForElementAndIdentifier(navigation, "workspace-navigation") as WorkspaceNavigationController | null : null;
}

function residencyController(): WorkspaceResidencyController | null {
  const residency = document.querySelector<HTMLElement>('[data-controller~="workspace-residency"]');
  // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
  return residency ? application.getControllerForElementAndIdentifier(residency, "workspace-residency") as WorkspaceResidencyController | null : null;
}

class WorkspaceAppFrameController extends Controller {
  static values = { workspaceId: String, appKey: String, initialPath: String };
  declare readonly element: HTMLIFrameElement;
  declare readonly workspaceIdValue: string;
  declare readonly appKeyValue: string;
  declare readonly initialPathValue: string;
  declare readonly hasInitialPathValue: boolean;
  private loadedUrl?: string;
  private pendingLoad?: { url: string; promise: Promise<void> };

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
    void this.loadAndWait();
  }

  loadAndWait(): Promise<void> {
    const src = this.frameSrc();
    if (this.loadedUrl === src) return Promise.resolve();
    if (this.pendingLoad?.url === src) return this.pendingLoad.promise;
    if (this.element.src === src && this.element.contentDocument?.readyState === "complete") {
      this.loadedUrl = src;
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve) => {
      this.element.addEventListener("load", () => {
        this.loadedUrl = src;
        this.pendingLoad = undefined;
        resolve();
      }, { once: true });
      if (this.element.src !== src) this.element.src = src;
    });
    this.pendingLoad = { url: src, promise };
    return promise;
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
    const codeCopied = this.element.dataset.oauthCodeCopied === "true";
    const authenticationStarted = this.element.dataset.oauthAuthenticationStarted === "true";
    const html = await response.text();
    window.Turbo?.renderStreamMessage(html);
    if (codeCopied || authenticationStarted) window.requestAnimationFrame(() => this.restoreDeviceCodeState(codeCopied, authenticationStarted));
  }

  showDeviceAuth(): void {
    this.element.dataset.oauthCodeCopied = "true";
    this.element.querySelector<HTMLElement>("[data-oauth-device-auth]")!.hidden = false;
  }

  showWaitingStatus(): void {
    this.element.dataset.oauthAuthenticationStarted = "true";
    this.element.querySelector<HTMLElement>("[data-oauth-waiting-status]")!.hidden = false;
  }

  private restoreDeviceCodeState(codeCopied: boolean, authenticationStarted: boolean): void {
    const dialog = document.querySelector<HTMLElement>("#settings_flow_dialog")!;
    const deviceAuth = dialog.querySelector<HTMLElement>("[data-oauth-device-auth]");
    if (!deviceAuth) return;
    if (codeCopied) {
      dialog.dataset.oauthCodeCopied = "true";
      deviceAuth.hidden = false;
      const copyButton = dialog.querySelector<HTMLButtonElement>('[data-oauth-copy-button="true"]')!;
      showTransientFeedback(copyButton);
    }
    if (authenticationStarted) {
      dialog.dataset.oauthAuthenticationStarted = "true";
      dialog.querySelector<HTMLElement>("[data-oauth-waiting-status]")!.hidden = false;
    }
  }
}

class SettingsAutosaveController extends Controller {
  declare readonly element: HTMLFormElement;

  submit(event: Event): void {
    event.preventDefault();
    void this.save();
  }

  saveWhenLeaving(event: FocusEvent): void {
    if (event.target instanceof HTMLButtonElement && event.target.type === "submit") return;
    if (event.relatedTarget instanceof Node && this.element.contains(event.relatedTarget)) return;
    if (!this.element.checkValidity()) return;
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

class SettingsPrefetchController extends Controller {
  private prefetched?: Promise<string>;
  private expiresAt = 0;

  prefetch(): void {
    void this.settingsHtml().catch((error) => console.error("Settings prefetch failed", error));
  }

  async open(event: Event): Promise<void> {
    event.preventDefault();
    const html = await this.settingsHtml();
    this.prefetched = undefined;
    this.expiresAt = 0;
    window.Turbo?.renderStreamMessage(html);
  }

  private settingsHtml(): Promise<string> {
    if (this.prefetched && this.expiresAt > Date.now()) return this.prefetched;
    this.expiresAt = Date.now() + 10_000;
    this.prefetched = fetch("/settings", { headers: { Accept: "text/vnd.turbo-stream.html" } }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    }).catch((error) => {
      this.prefetched = undefined;
      this.expiresAt = 0;
      throw error;
    });
    return this.prefetched;
  }
}

class ServerFilterController extends Controller {
  private timer?: ReturnType<typeof setTimeout>;

  disconnect(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  submit(): void {
    if (this.timer) clearTimeout(this.timer);
    // SAFETY: The controller is attached only to server-rendered filter forms.
    this.timer = setTimeout(() => (this.element as HTMLFormElement).requestSubmit(), 200);
  }
}

class ModelCatalogueController extends Controller {
  private observer?: MutationObserver;

  connect(): void {
    this.observer = new MutationObserver(() => this.sortModels());
    this.observer.observe(this.element, { childList: true, subtree: true });
    this.sortModels();
  }

  disconnect(): void {
    this.observer?.disconnect();
  }

  private sortModels(): void {
    const items = this.element.querySelector<HTMLElement>(".managed-list__items");
    if (!items) return;
    const current = Array.from(items.querySelectorAll<HTMLElement>(":scope > .model-catalogue-row"));
    const sorted = [...current].sort((a, b) => {
      const aRank = a.dataset.popularityRank === undefined ? Number.MAX_SAFE_INTEGER : Number(a.dataset.popularityRank);
      const bRank = b.dataset.popularityRank === undefined ? Number.MAX_SAFE_INTEGER : Number(b.dataset.popularityRank);
      const aConnected = a.querySelector<HTMLElement>(":scope > .model-provider-state")?.dataset.connected === "true";
      const bConnected = b.querySelector<HTMLElement>(":scope > .model-provider-state")?.dataset.connected === "true";
      return aRank - bRank || Number(bConnected) - Number(aConnected) || (a.dataset.modelSort ?? "").localeCompare(b.dataset.modelSort ?? "");
    });
    if (current.every((model, index) => model === sorted[index])) return;
    for (const model of sorted) items.append(model);
    const more = items.querySelector<HTMLElement>(":scope > .model-catalogue-more");
    if (more) items.append(more);
  }
}

function hasWorkingModelSetup(root: ParentNode | undefined): boolean {
  return root?.querySelector<HTMLElement>(".model-setup-working-state")?.dataset.working === "true";
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
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-onboarding-complete"] });
    this.show(this.paneTargets.findIndex((pane) => !pane.hidden));
  }

  disconnect(): void {
    this.observer?.disconnect();
  }

  next(): void {
    if (this.index >= this.paneTargets.length - 1) {
      // SAFETY: The server-rendered DOM and connected controller contract establish this element shape.
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
    this.paneTargets.forEach((pane, paneIndex) => { pane.hidden = paneIndex !== this.index; });
    this.dotTargets.forEach((dot, dotIndex) => {
      if (dotIndex === this.index) dot.setAttribute("aria-current", "step");
      else dot.removeAttribute("aria-current");
    });
    const current = this.paneTargets[this.index];
    const kind = current?.dataset.onboardingKind;
    const workingModel = hasWorkingModelSetup(current);
    const complete = current?.dataset.onboardingComplete === "true" || (kind === "llm" && workingModel);
    if (kind === "done") this.refreshChecklist(current);
    const doneComplete = kind === "done" && current?.querySelector<HTMLElement>("[data-onboarding-done-complete]")?.dataset.onboardingDoneComplete === "true";
    if (this.hasBackTarget) this.backTarget.hidden = this.index === 0;
    if (this.hasContinueTarget) {
      this.continueTarget.classList.toggle("primary", kind === "done" ? Boolean(doneComplete) : complete);
      let label = "Continue";
      if (kind === "done") label = doneComplete ? "Let’s start!" : "Start anyway";
      else if (kind === "llm" && !workingModel) label = "Continue without models for now";
      else if (kind === "github" && !complete) label = "Continue without setting up github";
      if (this.continueTarget.textContent !== label) this.continueTarget.textContent = label;
    }
  }

  private refreshChecklist(donePane?: HTMLElement): void {
    const done = donePane?.querySelector<HTMLElement>("[data-onboarding-done-complete]");
    if (!done) return;
    done.querySelectorAll<HTMLElement>("[data-onboarding-check]").forEach((item) => {
      const id = item.dataset.onboardingCheck;
      const pane = this.paneTargets.find((candidate) => candidate.dataset.onboardingKind === id);
      const workingModel = hasWorkingModelSetup(pane);
      const complete = pane ? (pane.dataset.onboardingComplete === "true" || (id === "llm" && workingModel)) : item.getAttribute("aria-checked") === "true";
      const completeValue = complete ? "true" : "false";
      if (item.getAttribute("aria-checked") !== completeValue) item.setAttribute("aria-checked", completeValue);
      const marker = item.querySelector(".status-list__marker");
      const markerText = complete ? "✓" : "";
      if (marker && marker.textContent !== markerText) marker.textContent = markerText;
    });
    const checks = Array.from(done.querySelectorAll<HTMLElement>("[data-onboarding-check]"));
    const completed = checks.filter((item) => item.getAttribute("aria-checked") === "true").length;
    const allComplete = completed === checks.length;
    done.dataset.onboardingDoneComplete = allComplete ? "true" : "false";
    const title = done.querySelector("h2");
    const titleText = allComplete ? "You’re all set up and ready to start using Atelier" : `${completed}/${checks.length} onboarding steps completed`;
    if (title && title.textContent !== titleText) title.textContent = titleText;
  }
}

class AgentModelSetupController extends StimulusController<HTMLElement> {
  async open(event: Event): Promise<void> {
    event.preventDefault();
    const controlledMenuId = this.element.getAttribute("aria-controls");
    const menu = this.element.closest<HTMLElement>(".popup-menu[popover]") ?? (controlledMenuId ? document.getElementById(controlledMenuId) : null);
    if (menu?.matches(":popover-open")) menu.hidePopover();
    const response = await fetch("/settings/models/dialog", { headers: { Accept: "text/vnd.turbo-stream.html" } });
    window.Turbo!.renderStreamMessage(await response.text());
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

const ProjectGithubSearchController = createHtmlAutocompleteController(Controller, {
  optionSelector: ":is(.agent-completion-option, [data-agent-completion-option])",
  loadingHtml: autocompleteHtml({ kind: "message", role: "status", content: { kind: "html", html: '<span class="agent-completion-spinner" aria-hidden="true"></span>Searching GitHub…' } }),
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

function cableRequestHeaders(initial: HeadersInit = {}): Headers {
  const headers = new Headers(initial);
  const connectionId = window.AtelierCable?.connectionId();
  if (connectionId) headers.set(atelierCableConnectionHeader, connectionId);
  return headers;
}

document.addEventListener("turbo:before-fetch-request", (event) => {
  // SAFETY: Turbo is the sole producer of this event and provides mutable fetch options.
  const detail = (event as CustomEvent<{ fetchOptions: RequestInit }>).detail;
  detail.fetchOptions.headers = cableRequestHeaders(detail.fetchOptions.headers);
});

class CableShellController extends Controller {
  connect(): void {
    window.AtelierCable?.subscribe(CableTopics.shell());
  }
}

const devReloadResponseSchema = Type.Object({ revision: Type.Integer({ minimum: 0 }) });
const devReloadRevisionParam = "__atelier_dev_reload";

class DevReloadController extends Controller {
  static values = { url: String };

  declare readonly urlValue: string;

  private revision: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;

  connect(): void {
    this.connected = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has(devReloadRevisionParam)) {
      url.searchParams.delete(devReloadRevisionParam);
      window.history.replaceState(window.history.state, "", url);
    }
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
        const value: unknown = await response.json();
        if (!Value.Check(devReloadResponseSchema, value)) throw new Error("invalid dev reload response");
        if (this.revision !== undefined && value.revision !== this.revision) {
          // A reload cannot participate in a cross-document View Transition, but
          // a same-origin replacement can. The throwaway query makes this a real
          // replacement navigation even though it returns to the same page.
          const url = new URL(window.location.href);
          url.searchParams.set(devReloadRevisionParam, String(value.revision));
          window.location.replace(url);
          return;
        }
        this.revision = value.revision;
      }
    } catch {
      // Server restarts temporarily make the development endpoint unavailable.
    }
    if (this.connected) this.timer = setTimeout(() => void this.poll(), 1_000);
  }
}

installSoftwareKeyboardTracking();
const application = Application.start();
installWorkspacePresentationTurboStream(Turbo, application);
Turbo.StreamActions["select-workspace"] = function selectWorkspace(this: HTMLElement): void {
  const workspaceId = this.dataset.workspaceId;
  if (!workspaceId) throw new Error("select-workspace requires a Workspace id");
  void workspaceNavigationController()?.selectWorkspaceById(workspaceId);
};
for (const module of workspaceClientModules) await module.install({ application, Controller, hooks: clientHooks });
application.register("cable-shell", CableShellController);
application.register("dev-reload", DevReloadController);
application.register("workspace-presentation", createWorkspacePresentationController(Controller, application, clientHooks));
application.register("workspace-command-form", WorkspaceCommandFormController);
application.register("empty-workspace-onboarding", EmptyWorkspaceOnboardingController);
registerDesignSystemControllers(application);
application.register("workspace-navigation", WorkspaceNavigationController);
application.register("workspace-residency", WorkspaceResidencyController);
application.register("atelier-shortcuts", AtelierShortcutsController);
application.register("atelier-fullscreen", AtelierFullscreenController);
application.register("submit-shortcut", SubmitShortcutController);
application.register("modal", ModalController);
application.register("modal-opener", ModalOpenerController);
application.register("launch-composer-dialog", LaunchComposerDialogController);
application.register("project-github-search", ProjectGithubSearchController);
application.register("provision-terminal", createProvisionTerminalController(Controller));
application.register("auto-scroll", AutoScrollController);
application.register("workspace-app-frame", WorkspaceAppFrameController);
application.register("theme-select", ThemeSelectController);
application.register("oauth-flow", OAuthFlowController);
application.register("git-identity", GitIdentityController);
application.register("settings-autosave", SettingsAutosaveController);
application.register("settings-prefetch", SettingsPrefetchController);
application.register("server-filter", ServerFilterController);
application.register("model-catalogue", ModelCatalogueController);
application.register("onboarding", OnboardingController);
application.register("clipboard", ClipboardController);
application.register("agent-model-setup", AgentModelSetupController);

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/service-worker.js");
}
