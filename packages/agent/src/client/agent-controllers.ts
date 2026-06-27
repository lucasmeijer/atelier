/// <reference lib="dom" />

import { createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import type { WorkspaceClientModule } from "@atelier/shared";

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };

type StimulusApplication = {
  getControllerForElementAndIdentifier(element: Element, identifier: string): unknown;
};

declare global {
  interface Window {
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

interface AgentPaneControllerInstance {
  start(): void;
  stop(): void;
  revealLatestAssistant(): void;
}

// ---------------------------------------------------------------------------
// agent-pane: SSE lifecycle, scroll anchoring, prompt behavior, rewind dialog
// ---------------------------------------------------------------------------

function createAgentPaneController(Controller: StimulusControllerConstructor) {
  return class AgentPaneController extends Controller implements AgentPaneControllerInstance {
    static values = { workspaceId: String, label: String };
    static targets = ["stream", "transcript", "input", "form", "rewindDialog", "rewindEntry", "rewindPreview"];
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly labelValue: string;
    declare readonly streamTarget: HTMLElement;
    declare readonly transcriptTarget: HTMLElement;
    declare readonly inputTarget: HTMLTextAreaElement;
    declare readonly formTarget: HTMLFormElement;
    declare readonly rewindDialogTarget: HTMLDialogElement;
    declare readonly rewindEntryTarget: HTMLInputElement;
    declare readonly rewindPreviewTarget: HTMLElement;

    private stuck = true;
    private observer?: MutationObserver;
    private rewindUserText = "";
    private readonly onScroll = (): void => {
      const el = this.transcriptTarget;
      this.stuck = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    };
    private readonly onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && this.element.closest(".tab-pane")?.classList.contains("active")) {
        void fetch(this.path("/abort"), { method: "POST" });
      }
    };
    connect(): void {
      this.observer = new MutationObserver(() => {
        if (this.stuck) {
          requestAnimationFrame(() => {
            this.transcriptTarget.scrollTop = this.transcriptTarget.scrollHeight;
          });
        }
      });
      this.observer.observe(this.transcriptTarget, { childList: true, subtree: true, characterData: true });
      this.transcriptTarget.addEventListener("scroll", this.onScroll);
      document.addEventListener("keydown", this.onKeydown);
      if (this.element.closest(".tab-pane")?.classList.contains("active")) this.start();
    }

    disconnect(): void {
      this.observer?.disconnect();
      this.transcriptTarget.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("keydown", this.onKeydown);
      this.stop();
    }

    start(): void {
      requestAnimationFrame(() => this.autosize());
      const src = this.path("/events");
      if (this.streamTarget.querySelector("turbo-stream-source")?.getAttribute("src") === src) return;
      const source = document.createElement("turbo-stream-source");
      source.setAttribute("src", src);
      this.streamTarget.replaceChildren(source);
    }

    stop(): void {
      this.streamTarget.replaceChildren();
    }

    revealLatestAssistant(): void {
      const finals = [...this.transcriptTarget.querySelectorAll<HTMLElement>(".agent-final")]
        .filter((element) => element.textContent?.trim());
      const target = finals.at(-1);
      if (!target) return;
      const transcriptTop = this.transcriptTarget.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top;
      this.stuck = false;
      this.transcriptTarget.scrollTop += targetTop - transcriptTop;
    }

    private path(suffix: string): string {
      return `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agents/${encodeURIComponent(this.labelValue)}${suffix}`;
    }

    // ---- prompt box ----

    inputKeydown(event: KeyboardEvent): void {
      // Enter inserts a newline; ⌘/Ctrl+Enter sends (or follow-ups when busy).
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (this.inputTarget.value.trim() || this.formTarget.querySelector(".agent-chip")) {
          const submitter = this.formTarget.querySelector<HTMLButtonElement>('button[value="send"], button[value="steer"]');
          this.formTarget.requestSubmit(submitter ?? undefined);
        }
      }
    }

    focusInput(event: Event): void {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("button, select, input, a, textarea, .agent-chip")) return;
      const input = this.inputTarget;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }

    autosize(): void {
      const input = this.inputTarget;
      const maxHeight = Number.parseFloat(getComputedStyle(input).getPropertyValue("--agent-input-max-height")) || 260;
      input.style.height = "auto";
      // Add a small buffer for fractional line-height/browser rounding so a
      // one-pixel overflow doesn't flash a scrollbar before the real limit.
      const nextHeight = Math.ceil(input.scrollHeight) + 2;
      input.style.height = `${Math.min(nextHeight, maxHeight)}px`;
      input.style.overflowY = nextHeight > maxHeight ? "auto" : "hidden";
    }

    submitted(event: Event): void {
      const detail = (event as CustomEvent).detail as { success?: boolean } | undefined;
      if (detail?.success === false) return;
      this.inputTarget.value = "";
      this.autosize();
      // Attachments were delivered with the message; clear the chips.
      this.formTarget.querySelectorAll(".agent-chip").forEach((chip) => chip.remove());
      this.stuck = true;
      this.transcriptTarget.scrollTop = this.transcriptTarget.scrollHeight;
      this.inputTarget.focus();
    }

    // ---- rewind ----

    openRewind(event: Event): void {
      const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      if (!button) return;
      this.rewindEntryTarget.value = button.dataset.entryId ?? "";
      this.rewindUserText = button.dataset.userText ?? "";
      const preview = this.rewindUserText.length > 80 ? `${this.rewindUserText.slice(0, 80)}…` : this.rewindUserText;
      this.rewindPreviewTarget.textContent = `“${preview}”`;
      if (!this.rewindDialogTarget.open) this.rewindDialogTarget.showModal();
    }

    closeRewind(): void {
      this.rewindDialogTarget.close();
    }

    rewindPickCustom(event: Event): void {
      const textarea = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      const label = textarea?.closest(".agent-rewind-opt");
      const radio = label?.querySelector<HTMLInputElement>("input[type=radio]");
      if (radio) radio.checked = true;
    }

    rewindSubmitted(): void {
      // Close immediately on submit; the rewind itself streams in via SSE
      // (summaries behave like a busy agent with a stop button).
      this.rewindDialogTarget.close();
      if (this.rewindUserText && !this.inputTarget.value.trim()) {
        this.inputTarget.value = this.rewindUserText;
        this.autosize();
        this.inputTarget.focus();
      }
    }
  };
}

// ---------------------------------------------------------------------------
// agent-autosubmit: submit a small form when its select changes
// ---------------------------------------------------------------------------

function createAgentAutosubmitController(Controller: StimulusControllerConstructor) {
  return class AgentAutosubmitController extends Controller {
    declare readonly element: HTMLFormElement;

    submit(): void {
      this.element.requestSubmit();
    }
  };
}

// ---------------------------------------------------------------------------
// agent-elapsed: ticking elapsed time inside the stop button
// ---------------------------------------------------------------------------

function createAgentElapsedController(Controller: StimulusControllerConstructor) {
  return class AgentElapsedController extends Controller {
    static values = { since: Number, max: Number };
    static targets = ["time"];
    declare readonly sinceValue: number;
    declare readonly maxValue: number;
    declare readonly hasMaxValue: boolean;
    declare readonly timeTargets: HTMLElement[];
    private timer?: ReturnType<typeof setInterval>;

    connect(): void {
      const format = (seconds: number): string => {
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}`;
      };
      const update = () => {
        const seconds = Math.max(0, Math.round((Date.now() - this.sinceValue) / 1000));
        const max = this.hasMaxValue && this.maxValue > 0 ? ` max ${format(this.maxValue)}` : "";
        for (const target of this.timeTargets) target.textContent = `${format(seconds)}${max}`;
      };
      update();
      this.timer = setInterval(update, 1000);
    }

    disconnect(): void {
      if (this.timer) clearInterval(this.timer);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-copy: copy rendered bash output to clipboard
// ---------------------------------------------------------------------------

function createAgentCopyController(Controller: StimulusControllerConstructor) {
  return class AgentCopyController extends Controller {
    declare readonly element: HTMLButtonElement;
    private timer?: ReturnType<typeof setTimeout>;

    disconnect(): void {
      if (this.timer) clearTimeout(this.timer);
    }

    async copy(event: Event): Promise<void> {
      event.preventDefault();
      event.stopPropagation();
      const tool = this.element.closest(".agent-tool");
      const checked = tool?.querySelector<HTMLInputElement>(".agent-bash-mode-input:checked");
      const pane = checked?.classList.contains("agent-bash-mode-model")
        ? tool?.querySelector<HTMLElement>(".agent-bash-pane-model")
        : tool?.querySelector<HTMLElement>(".agent-bash-pane-terminal");
      const result = pane?.querySelector<HTMLElement>(".agent-tool-result") ?? tool?.querySelector<HTMLElement>(".agent-tool-result");
      const text = result?.textContent ?? "";
      if (!text) return;
      await navigator.clipboard.writeText(text);
      this.element.classList.add("copied");
      this.element.setAttribute("aria-label", "Copied bash output");
      const icon = this.element.querySelector<HTMLElement>(".agent-tool-copy-icon");
      if (icon) icon.textContent = "✓";
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.element.classList.remove("copied");
        this.element.setAttribute("aria-label", "Copy bash output to clipboard");
        if (icon) icon.textContent = "⧉";
      }, 1400);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-notice: transient notice lines auto-dismiss
// ---------------------------------------------------------------------------

function createAgentNoticeController(Controller: StimulusControllerConstructor) {
  return class AgentNoticeController extends Controller {
    declare readonly element: HTMLElement;
    private timer?: ReturnType<typeof setTimeout>;

    connect(): void {
      this.timer = setTimeout(() => this.element.remove(), 8000);
    }

    disconnect(): void {
      if (this.timer) clearTimeout(this.timer);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-proxy: fill canonical proxy URLs for server-rendered embeds
// ---------------------------------------------------------------------------

function encodeFilePath(path: string): string {
  return path.split("/").map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/");
}

function workspaceProxyUrl(workspaceId: string, appKey: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (appKey === "file") return `/workspaces/${encodeURIComponent(workspaceId)}/files${encodeFilePath(normalizedPath)}`;
  const portMatch = appKey.match(/^port-(\d+)$/);
  if (portMatch) return `/workspaces/${encodeURIComponent(workspaceId)}/ports/${portMatch[1]}${normalizedPath}`;
  return `/workspaces/${encodeURIComponent(workspaceId)}/apps/${encodeURIComponent(appKey)}${normalizedPath}`;
}

function createAgentProxyController(Controller: StimulusControllerConstructor) {
  return class AgentProxyController extends Controller {
    static values = { workspaceId: String, appKey: String, path: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly appKeyValue: string;
    declare readonly pathValue: string;

    connect(): void {
      const url = workspaceProxyUrl(this.workspaceIdValue, this.appKeyValue, this.pathValue || "/");
      if (this.element instanceof HTMLAnchorElement) this.element.href = url;
      else if (this.element instanceof HTMLImageElement || this.element instanceof HTMLVideoElement || this.element instanceof HTMLIFrameElement) this.element.src = url;
    }
  };
}

// ---------------------------------------------------------------------------
// agent-media-fullscreen: show inline HTML/image/video previews in a fullscreen modal
// ---------------------------------------------------------------------------

type FullscreenMediaElement = HTMLIFrameElement | HTMLImageElement | HTMLVideoElement;

function createAgentMediaFullscreenController(Controller: StimulusControllerConstructor) {
  let hovered: { open(): void } | undefined;
  let connected = 0;

  const consumePlainF = (event: KeyboardEvent): boolean => {
    if (event.key.toLowerCase() !== "f" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return false;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return false;
    event.preventDefault();
    return true;
  };

  const documentKeydown = (event: KeyboardEvent): void => {
    if (!hovered || !consumePlainF(event)) return;
    hovered.open();
  };

  return class AgentMediaFullscreenController extends Controller {
    declare readonly element: HTMLElement;
    private dialog?: HTMLDialogElement;
    private media?: FullscreenMediaElement;
    private readonly loaded = (): void => this.attachFrameShortcut();
    private readonly pointerenter = (): void => { hovered = this; };
    private readonly pointerleave = (): void => { if (hovered === this) hovered = undefined; };
    private readonly frameKeydown = (event: KeyboardEvent): void => {
      if (!consumePlainF(event)) return;
      if (this.dialog?.open) this.dialog.close();
      else this.open();
    };
    private readonly dialogKeydown = (event: KeyboardEvent): void => {
      if (!consumePlainF(event)) return;
      this.dialog?.close();
    };

    connect(): void {
      this.media = this.findMedia();
      if (this.media instanceof HTMLIFrameElement) {
        this.media.addEventListener("load", this.loaded);
        this.attachFrameShortcut();
      }
      this.element.addEventListener("pointerenter", this.pointerenter);
      this.element.addEventListener("pointerleave", this.pointerleave);
      if (connected++ === 0) document.addEventListener("keydown", documentKeydown, true);
    }

    disconnect(): void {
      if (hovered === this) hovered = undefined;
      if (this.media instanceof HTMLIFrameElement) {
        this.media.removeEventListener("load", this.loaded);
        this.detachFrameShortcut();
      }
      this.element.removeEventListener("pointerenter", this.pointerenter);
      this.element.removeEventListener("pointerleave", this.pointerleave);
      if (--connected === 0) document.removeEventListener("keydown", documentKeydown, true);
      this.dialog?.close();
      this.dialog?.remove();
      this.dialog = undefined;
    }

    open(): void {
      if (this.dialog?.open) {
        this.dialog.close();
        return;
      }
      const source = this.media ?? this.findMedia();
      if (!source) return;
      const src = this.mediaSrc(source);
      if (!src) return;

      const dialog = document.createElement("dialog");
      dialog.className = "agent-media-fullscreen-dialog";

      const header = document.createElement("div");
      header.className = "agent-media-fullscreen-bar";
      const title = document.createElement("span");
      title.textContent = this.title(source);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "agent-media-fullscreen-close";
      close.textContent = "Close";
      close.addEventListener("click", () => dialog.close());
      header.append(title, close);

      const viewer = this.createViewer(source, src);
      dialog.append(header, viewer.element);
      dialog.addEventListener("keydown", this.dialogKeydown);
      dialog.addEventListener("close", () => {
        viewer.disconnect?.();
        dialog.removeEventListener("keydown", this.dialogKeydown);
        dialog.remove();
        if (this.dialog === dialog) this.dialog = undefined;
      }, { once: true });
      document.body.append(dialog);
      this.dialog = dialog;
      dialog.showModal();
      viewer.connect?.();
    }

    private findMedia(): FullscreenMediaElement | undefined {
      if (this.element instanceof HTMLIFrameElement || this.element instanceof HTMLImageElement || this.element instanceof HTMLVideoElement) return this.element;
      return this.element.querySelector<HTMLIFrameElement | HTMLImageElement | HTMLVideoElement>("iframe, img, video") ?? undefined;
    }

    private createViewer(source: FullscreenMediaElement, src: string): { element: HTMLElement; connect?: () => void; disconnect?: () => void } {
      if (source instanceof HTMLIFrameElement) {
        const frame = document.createElement("iframe");
        frame.className = "agent-media-fullscreen-iframe";
        frame.src = src;
        for (const attr of ["sandbox", "allow", "referrerpolicy"] as const) {
          const value = source.getAttribute(attr);
          if (value !== null) frame.setAttribute(attr, value);
        }
        const attachModalShortcut = (): void => {
          const doc = frame.contentDocument;
          if (!doc) return;
          doc.removeEventListener("keydown", this.dialogKeydown);
          doc.addEventListener("keydown", this.dialogKeydown);
        };
        frame.addEventListener("load", attachModalShortcut);
        return {
          element: frame,
          connect: attachModalShortcut,
          disconnect: () => {
            frame.removeEventListener("load", attachModalShortcut);
            frame.contentDocument?.removeEventListener("keydown", this.dialogKeydown);
          },
        };
      }

      if (source instanceof HTMLVideoElement) {
        const video = document.createElement("video");
        video.className = "agent-media-fullscreen-video";
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
      image.className = "agent-media-fullscreen-img";
      image.src = src;
      image.alt = source.alt;
      return { element: image };
    }

    private attachFrameShortcut(): void {
      const doc = this.media instanceof HTMLIFrameElement ? this.media.contentDocument : undefined;
      if (!doc) return;
      doc.removeEventListener("keydown", this.frameKeydown);
      doc.addEventListener("keydown", this.frameKeydown);
    }

    private detachFrameShortcut(): void {
      const doc = this.media instanceof HTMLIFrameElement ? this.media.contentDocument : undefined;
      doc?.removeEventListener("keydown", this.frameKeydown);
    }

    private mediaSrc(media: FullscreenMediaElement): string {
      if (media instanceof HTMLImageElement) return media.currentSrc || media.src || this.proxyUrl(media);
      if (media instanceof HTMLVideoElement) return media.currentSrc || media.src || this.proxyUrl(media);
      return media.src || this.proxyUrl(media);
    }

    private proxyUrl(element: HTMLElement): string {
      const workspaceId = element.dataset.agentProxyWorkspaceIdValue;
      const appKey = element.dataset.agentProxyAppKeyValue;
      const path = element.dataset.agentProxyPathValue;
      if (!workspaceId || !appKey) return "";
      return workspaceProxyUrl(workspaceId, appKey, path || "/");
    }

    private title(media: FullscreenMediaElement): string {
      if (media instanceof HTMLImageElement) return media.alt || "Image";
      return this.element.querySelector(".agent-media-frame-bar span")?.textContent || media.getAttribute("title") || "Preview";
    }
  };
}

// ---------------------------------------------------------------------------
// agent-html-preview: expand same-origin HTML previews to their content height
// ---------------------------------------------------------------------------

function createAgentHtmlPreviewController(Controller: StimulusControllerConstructor) {
  return class AgentHtmlPreviewController extends Controller {
    declare readonly element: HTMLIFrameElement;
    private resizeObserver?: ResizeObserver;
    private mutationObserver?: MutationObserver;
    private readonly loaded = (): void => this.attach();

    connect(): void {
      this.element.addEventListener("load", this.loaded);
      if (this.element.contentDocument?.readyState === "complete") this.attach();
    }

    disconnect(): void {
      this.element.removeEventListener("load", this.loaded);
      this.resizeObserver?.disconnect();
      this.mutationObserver?.disconnect();
    }

    private attach(): void {
      this.resizeObserver?.disconnect();
      this.mutationObserver?.disconnect();

      const doc = this.element.contentDocument!;
      const html = doc.documentElement;
      const body = doc.body;
      const resize = (): void => {
        this.element.style.height = `${Math.max(
          420,
          html.scrollHeight,
          html.offsetHeight,
          html.clientHeight,
          body.scrollHeight,
          body.offsetHeight,
          body.clientHeight,
        )}px`;
      };

      resize();
      this.resizeObserver = new ResizeObserver(resize);
      this.resizeObserver.observe(html);
      this.resizeObserver.observe(body);
      this.mutationObserver = new MutationObserver(resize);
      this.mutationObserver.observe(html, { attributes: true, childList: true, characterData: true, subtree: true });
      void doc.fonts.ready.then(resize);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-attachments: drag & drop + uploads with progress chips
// ---------------------------------------------------------------------------

let dropGuardInstalled = false;

function installDropGuard(): void {
  if (dropGuardInstalled) return;
  dropGuardInstalled = true;
  // Never let a stray drop navigate the app away.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
}

function createAgentAttachmentsController(Controller: StimulusControllerConstructor) {
  return class AgentAttachmentsController extends Controller {
    static values = { uploadUrl: String };
    static targets = ["row", "hint"];
    declare readonly element: HTMLElement;
    declare readonly uploadUrlValue: string;
    declare readonly rowTarget: HTMLElement;

    connect(): void {
      installDropGuard();
    }

    dragOver(event: DragEvent): void {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      this.element.classList.add("agent-dropping");
    }

    dragLeave(event: DragEvent): void {
      if (event.target === this.element) this.element.classList.remove("agent-dropping");
    }

    drop(event: DragEvent): void {
      this.element.classList.remove("agent-dropping");
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      for (const file of Array.from(files)) this.upload(file);
    }

    remove(event: Event): void {
      const button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      const attachmentId = button?.dataset.attachmentId;
      if (!attachmentId) return;
      const url = new URL(this.uploadUrlValue, window.location.href);
      url.search = "";
      url.pathname = `${url.pathname}/${encodeURIComponent(attachmentId)}/delete`;
      void fetch(url, { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html" } })
        .then((response) => response.text())
        .then((html) => window.Turbo?.renderStreamMessage(html));
    }

    private upload(file: File): void {
      const temp = document.createElement("span");
      temp.className = "agent-chip uploading";
      temp.innerHTML = `<span class="agent-chip-ico">⬆</span><span class="agent-chip-name"></span><span class="agent-chip-prog"><i style="width:0%"></i></span>`;
      temp.querySelector(".agent-chip-name")!.textContent = file.name;
      this.rowTarget.appendChild(temp);

      const data = new FormData();
      data.append("file", file);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", this.uploadUrlValue);
      xhr.setRequestHeader("Accept", "text/vnd.turbo-stream.html");
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const bar = temp.querySelector<HTMLElement>(".agent-chip-prog i");
        if (bar) bar.style.width = `${Math.round((event.loaded / event.total) * 100)}%`;
      };
      xhr.onload = () => {
        temp.remove();
        if (xhr.status >= 200 && xhr.status < 300) window.Turbo?.renderStreamMessage(xhr.responseText);
      };
      xhr.onerror = () => {
        temp.classList.add("error");
        temp.querySelector(".agent-chip-ico")!.textContent = "✕";
        setTimeout(() => temp.remove(), 4000);
      };
      xhr.send(data);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-term: inline read-only xterm attached to an agent tmux session
// ---------------------------------------------------------------------------

function createAgentTermController(Controller: StimulusControllerConstructor) {
  return class AgentTermController extends Controller {
    static values = { workspaceId: String, label: String, session: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly sessionValue: string;
    private viewer?: ObservableTerminalViewer;
    private disposed = false;

    connect(): void {
      this.disposed = false;
      void createObservableTerminalViewer({
        host: this.element,
        mode: "fixed-readonly",
        cols: 120,
        rows: 30,
        websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agent-term/${encodeURIComponent(this.sessionValue)}/ws?cols=120&rows=30`),
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: { background: "#161a22", foreground: "#d3dae5" },
      }).then((viewer) => {
        if (this.disposed) viewer.dispose();
        else this.viewer = viewer;
      }).catch((error: unknown) => {
        this.element.textContent = `[terminal attach failed: ${error instanceof Error ? error.message : String(error)}]`;
      });
    }

    disconnect(): void {
      this.disposed = true;
      this.viewer?.dispose();
      this.viewer = undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// Tab activation hook
// ---------------------------------------------------------------------------

function activateAgentTab(application: StimulusApplication, group: Element, tabName: string, workspaceId?: string): void {
  const targetPane = tabName.startsWith("agent:")
    ? group.querySelector<HTMLElement>(`.tab-pane[data-tab-pane="${CSS.escape(tabName)}"] [data-controller~="agent-pane"]`)
    : null;

  for (const pane of document.querySelectorAll<HTMLElement>('[data-controller~="agent-pane"]')) {
    if (workspaceId && pane.dataset.agentPaneWorkspaceIdValue === workspaceId && pane === targetPane) continue;
    const controller = application.getControllerForElementAndIdentifier(pane, "agent-pane") as AgentPaneControllerInstance | null;
    controller?.stop();
  }

  if (!targetPane) return;
  const controller = application.getControllerForElementAndIdentifier(targetPane, "agent-pane") as AgentPaneControllerInstance | null;
  controller?.start();
}

export const agentClientModule: WorkspaceClientModule = {
  id: "agent",
  install({ application, Controller, hooks }) {
    application.register("agent-pane", createAgentPaneController(Controller));
    application.register("agent-attachments", createAgentAttachmentsController(Controller));
    application.register("agent-autosubmit", createAgentAutosubmitController(Controller));
    application.register("agent-copy", createAgentCopyController(Controller));
    application.register("agent-elapsed", createAgentElapsedController(Controller));
    application.register("agent-media-fullscreen", createAgentMediaFullscreenController(Controller));
    application.register("agent-html-preview", createAgentHtmlPreviewController(Controller));
    application.register("agent-notice", createAgentNoticeController(Controller));
    application.register("agent-proxy", createAgentProxyController(Controller));
    application.register("agent-term", createAgentTermController(Controller));

    hooks.onActivateTab(({ tabKey, workspaceId, group }) => activateAgentTab(application, group, tabKey, workspaceId));
    hooks.onChooseUnreadTab((tabs) => tabs.find((tab) => tab.startsWith("agent:")));
    hooks.onFocusGroup(({ pane }) => {
      const agentInput = pane?.querySelector<HTMLTextAreaElement>(".agent-input");
      if (!agentInput) return false;
      agentInput.focus();
      return true;
    });
    hooks.onRevealTab(({ tabKey, group }) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const pane = group.querySelector<HTMLElement>(`.tab-pane.active[data-tab-pane="${CSS.escape(tabKey)}"]`);
        const agentPane = pane?.querySelector<HTMLElement>('[data-controller~="agent-pane"]');
        const controller = agentPane ? application.getControllerForElementAndIdentifier(agentPane, "agent-pane") as AgentPaneControllerInstance | null : null;
        controller?.revealLatestAssistant();
      }));
    });
    hooks.onWorkspaceCommand((commandId) => {
      if (commandId !== "agent.launch-project-workspace") return false;
      const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.active");
      const projectId = resident?.dataset.projectId;
      if (!projectId) return true;
      const modalIdPart = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const dialog = document.getElementById(`agent_launch_project_modal_${modalIdPart}`) as HTMLDialogElement | null;
      if (!dialog) return true;
      if (!dialog.open) dialog.showModal();
      const input = dialog.querySelector<HTMLTextAreaElement>("textarea");
      if (input) requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
      return true;
    });
  },
};
