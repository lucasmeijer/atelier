/// <reference lib="dom" />

import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalTheme, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import { CableTopics, copyTextToClipboard, isWorkspacePaneVisible, workspaceProxyUrl, type AtelierCableClient, type CableIdentifier, type WorkspaceClientController, type WorkspaceClientModule, type WorkspacePaletteItem } from "@atelier/shared";
import { agentTreeOwnsMenu, handleAgentTreeKeydown, handleAgentTreeMenuEvent, selectAgentTreeOption } from "./session-tree.ts";
import { notifyInputListeners, setTextInputValue } from "./text-input.ts";

type StimulusControllerConstructor = new (...args: never[]) => { element: Element };

interface ScrollTranscript {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  getBoundingClientRect(): Pick<DOMRect, "top">;
}

interface TranscriptMessage {
  getBoundingClientRect(): Pick<DOMRect, "top">;
}

type HtmlAutocompleteRequest = { query: string; params?: Record<string, string>; debounceMs?: number };

interface HtmlAutocompleteInteraction {}

type HtmlAutocompleteOptions = {
  optionSelector: string;
  request(input: HTMLInputElement | HTMLTextAreaElement, force?: boolean): HtmlAutocompleteRequest | undefined;
  loadHtml?(request: HtmlAutocompleteRequest, url: URL, interaction: HtmlAutocompleteInteraction): Promise<string> | undefined;
  /** Return false when selection starts an interaction that owns the open menu. */
  select(option: HTMLElement, input: HTMLInputElement | HTMLTextAreaElement): boolean | void;
  keydown?(event: KeyboardEvent, input: HTMLInputElement | HTMLTextAreaElement, url: string, actions: HtmlAutocompleteActions): boolean;
  loadingHtml?: string;
  triggerKeysWhenClosed?: string[];
  fullscreenShortcut?: boolean | ((option: HTMLElement) => boolean);
  /** Return true when an event inside the menu has been handled. */
  menuEvent?(event: Event, input: HTMLInputElement | HTMLTextAreaElement): boolean | void;
};

type HtmlAutocompleteActions = {
  readonly open: boolean;
  readonly hasOptions: boolean;
  activeOption(): HTMLElement | undefined;
  select(option: HTMLElement): void;
  setInputValue(value: string): void;
  close(): void;
  refresh(force?: boolean): void;
};

function isSubmitShortcut(event: KeyboardEvent): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

type StimulusApplication = {
  getControllerForElementAndIdentifier(element: Element, identifier: string): WorkspaceClientController | null;
};

declare global {
  interface Window {
    Turbo?: { renderStreamMessage(html: string): void };
    AtelierCable?: AtelierCableClient;
  }
}

interface AgentPaneControllerInstance {
  start(): void;
  stop(): void;
}

interface AgentTermControllerInstance {
  start(): void;
  disconnect(): void;
}

function isAgentTermController(controller: WorkspaceClientController): controller is WorkspaceClientController & AgentTermControllerInstance {
  return "start" in controller && typeof controller.start === "function" && "disconnect" in controller && typeof controller.disconnect === "function";
}

function agentTermController(application: StimulusApplication, terminal: HTMLElement): AgentTermControllerInstance | null {
  const controller = application.getControllerForElementAndIdentifier(terminal, "agent-term");
  if (!controller) return null;
  if (!isAgentTermController(controller)) throw new Error("agent-term element is connected to an incompatible controller");
  return controller;
}

// ---------------------------------------------------------------------------
// agent-pane: cable subscription lifecycle, scroll anchoring, prompt behavior, rewind dialog
// ---------------------------------------------------------------------------

function scrollEnd(element: Pick<ScrollTranscript, "scrollHeight" | "clientHeight">): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function messageScrollTop(transcript: ScrollTranscript, message: TranscriptMessage): number {
  return transcript.scrollTop + message.getBoundingClientRect().top - transcript.getBoundingClientRect().top;
}

function messageScrollTarget(transcript: ScrollTranscript, message: TranscriptMessage): number {
  return Math.min(messageScrollTop(transcript, message), scrollEnd(transcript));
}

export function scrollMessageToTop(transcript: ScrollTranscript & Pick<HTMLElement, "scrollTo">, message: TranscriptMessage): void {
  transcript.scrollTo({ top: messageScrollTarget(transcript, message), behavior: "smooth" });
}

export function messageNavigationDirection(transcript: ScrollTranscript, message: TranscriptMessage): "up" | "down" | undefined {
  const distance = transcript.scrollTop - messageScrollTarget(transcript, message);
  return Math.abs(distance) < 1 ? undefined : distance > 0 ? "up" : "down";
}

export function transcriptFollowingAfterScroll(wasFollowing: boolean, previousEnd: number, scrollTop: number, nextEnd: number): boolean {
  const threshold = 60;
  const atNextEnd = scrollTop >= nextEnd - threshold;
  const endMovedAway = nextEnd > previousEnd;
  const remainedAtPreviousEnd = scrollTop >= previousEnd - threshold;
  return atNextEnd || (wasFollowing && endMovedAway && remainedAtPreviousEnd);
}

function createAgentPaneController(Controller: StimulusControllerConstructor) {
  return class AgentPaneController extends Controller implements AgentPaneControllerInstance {
    static values = { workspaceId: String, label: String, snapshotCursor: String };
    static targets = ["transcript", "transcriptNav", "messageDialog", "messageList", "input", "form", "rewindDialog", "rewindEntry", "rewindPreview"];
    declare readonly element: HTMLElement;
    declare readonly application: StimulusApplication;
    declare readonly workspaceIdValue: string;
    declare readonly labelValue: string;
    declare readonly snapshotCursorValue: string;
    declare readonly hasSnapshotCursorValue: boolean;
    declare readonly transcriptTarget: HTMLElement;
    declare readonly transcriptNavTarget: HTMLButtonElement;
    declare readonly messageDialogTarget: HTMLDialogElement;
    declare readonly messageListTarget: HTMLElement;
    declare readonly inputTarget: HTMLTextAreaElement;
    declare readonly formTarget: HTMLFormElement;
    declare readonly rewindDialogTarget: HTMLDialogElement;
    declare readonly rewindEntryTarget: HTMLInputElement;
    declare readonly rewindPreviewTarget: HTMLElement;

    private stuck = true;
    private subscribed = false;
    private hasSubscribed = false;
    private transcriptMutationObserver?: MutationObserver;
    private promptObserver?: MutationObserver;
    private transcriptLayoutObserver?: ResizeObserver;
    private transcriptLayoutFrame = 0;
    private transcriptEnd = 0;
    private rewindUserText = "";
    private messageDialogPopulatesPrompt = false;
    private historicalOpenItemIds = new Set<string>();
    private restoreHistoricalOpenItems(): void {
      for (const id of this.historicalOpenItemIds) this.transcriptTarget.querySelector<HTMLElement>(`#${CSS.escape(id)} details[data-agent-historical-detail]`)?.setAttribute("open", "");
    }
    private rememberHistoricalOpenItems(): void {
      this.historicalOpenItemIds = new Set([...this.transcriptTarget.querySelectorAll<HTMLDetailsElement>("details[data-agent-historical-detail][open]")].map((details) => details.closest<HTMLElement>(".agent-item")?.id).filter((id): id is string => Boolean(id)));
    }
    private readonly onScroll = (): void => {
      const el = this.transcriptTarget;
      const nextEnd = scrollEnd(el);
      this.stuck = transcriptFollowingAfterScroll(this.stuck, this.transcriptEnd, el.scrollTop, nextEnd);
      this.transcriptEnd = nextEnd;
      this.updateTranscriptNavigation();
    };
    private latestMessage(): HTMLElement | null {
      const messages = this.transcriptTarget.querySelectorAll<HTMLElement>(".agent-item");
      return messages.item(messages.length - 1);
    }
    private updateTranscriptNavigation(): void {
      const latest = this.latestMessage();
      const direction = latest ? messageNavigationDirection(this.transcriptTarget, latest) : undefined;
      this.element.classList.toggle("agent-transcript-at-end", this.stuck);
      if (direction) this.transcriptNavTarget.dataset.direction = direction;
      this.transcriptNavTarget.disabled = !direction;
      this.transcriptNavTarget.setAttribute("aria-hidden", String(!direction));
    }
    private updateTranscriptPosition(): void {
      if (!isWorkspacePaneVisible(this.element)) return;
      if (this.stuck) this.transcriptTarget.scrollTop = this.transcriptTarget.scrollHeight;
      this.onScroll();
    }
    private observeTranscriptItems(): void {
      for (const item of this.transcriptTarget.children) this.transcriptLayoutObserver!.observe(item);
    }
    private readonly transcriptLayoutChanged = (): void => {
      cancelAnimationFrame(this.transcriptLayoutFrame);
      this.transcriptLayoutFrame = requestAnimationFrame(() => this.updateTranscriptPosition());
    };
    private readonly onVisibilityChange = (): void => {
      if (document.visibilityState === "visible" && isWorkspacePaneVisible(this.element)) this.start();
      else this.stop();
    };
    connect(): void {
      this.transcriptLayoutObserver = new ResizeObserver(this.transcriptLayoutChanged);
      this.observeTranscriptItems();
      this.transcriptMutationObserver = new MutationObserver(() => {
        this.restoreHistoricalOpenItems();
        this.observeTranscriptItems();
      });
      this.transcriptMutationObserver.observe(this.transcriptTarget, { childList: true, subtree: true });
      this.promptObserver = new MutationObserver(() => this.updateSendStopButton());
      this.promptObserver.observe(this.formTarget, { childList: true, subtree: true });
      this.transcriptLayoutObserver.observe(this.element.querySelector<HTMLElement>(".agent-promptwrap")!);
      this.transcriptEnd = scrollEnd(this.transcriptTarget);
      this.transcriptTarget.addEventListener("scroll", this.onScroll);
      this.updateTranscriptNavigation();
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      const promptDraft = sessionStorage.getItem(this.promptDraftStorageKey);
      if (promptDraft !== null) this.inputTarget.value = promptDraft;
      this.updateSendStopButton();
      if (isWorkspacePaneVisible(this.element)) this.start();
    }

    disconnect(): void {
      this.transcriptMutationObserver?.disconnect();
      this.promptObserver?.disconnect();
      this.transcriptLayoutObserver?.disconnect();
      cancelAnimationFrame(this.transcriptLayoutFrame);
      this.transcriptTarget.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.stop();
    }

    start(): void {
      requestAnimationFrame(() => {
        this.autosize();
        this.updateTranscriptPosition();
      });
      if (document.visibilityState !== "visible" || !isWorkspacePaneVisible(this.element) || this.subscribed) return;
      this.startAgentTerminals();
      const options = this.hasSubscribed ? undefined : { upTo: this.hasSnapshotCursorValue ? this.snapshotCursorValue : undefined };
      window.AtelierCable?.subscribe(this.cableIdentifier(), options);
      this.subscribed = true;
      this.hasSubscribed = true;
    }

    stop(): void {
      this.rememberHistoricalOpenItems();
      if (!this.subscribed) return;
      window.AtelierCable?.unsubscribe(this.cableIdentifier());
      this.subscribed = false;
      this.disposeAgentTerminals();
    }

    private startAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        agentTermController(this.application, terminal)?.start();
      });
    }

    private path(suffix: string): string {
      return `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agents/${encodeURIComponent(this.labelValue)}${suffix}`;
    }

    private cableIdentifier(): CableIdentifier {
      return CableTopics.agent(this.workspaceIdValue, this.labelValue);
    }

    private disposeAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        agentTermController(this.application, terminal)?.disconnect();
        terminal.remove();
      });
    }

    // ---- transcript navigation ----

    jumpToLatestMessage(): void {
      const latest = this.latestMessage();
      if (latest) scrollMessageToTop(this.transcriptTarget, latest);
    }

    private userMessages(): HTMLElement[] {
      return [...this.transcriptTarget.querySelectorAll<HTMLElement>(".agent-item:has(.agent-user)")];
    }

    private messageLinks(): HTMLButtonElement[] {
      return [...this.messageListTarget.querySelectorAll<HTMLButtonElement>(".agent-message-link")];
    }

    private showMessageDialog(populatesPrompt: boolean): void {
      this.messageDialogPopulatesPrompt = populatesPrompt;
      this.messageListTarget.replaceChildren(...this.userMessages().map((message) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "agent-message-link";
        button.value = message.id;
        const preview = document.createElement("span");
        preview.className = "agent-message-link-text";
        preview.textContent = message.querySelector<HTMLElement>(".agent-user")?.textContent?.trim() || "Message with attachment";
        button.append(preview);
        return button;
      }));
      this.messageDialogTarget.showModal();
      requestAnimationFrame(() => {
        const messages = this.messageLinks();
        messages[populatesPrompt ? messages.length - 1 : 0]?.focus();
      });
    }

    openMessageDialog(): void {
      this.showMessageDialog(false);
    }

    messageDialogKeydown(event: KeyboardEvent): void {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const messages = this.messageLinks();
      if (messages.length === 0) return;
      event.preventDefault();
      const current = messages.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? messages.length - 1
        : event.key === "ArrowDown" ? (current + 1) % messages.length
        : ((current < 0 ? 0 : current) - 1 + messages.length) % messages.length;
      messages[next].focus();
    }

    closeMessageDialog(): void {
      this.messageDialogTarget.close();
      this.messageDialogPopulatesPrompt = false;
    }

    messageDialogClicked(event: MouseEvent): void {
      if (event.target === this.messageDialogTarget) {
        this.closeMessageDialog();
        return;
      }
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".agent-message-link") : null;
      if (!button) return;
      const message = this.transcriptTarget.querySelector<HTMLElement>(`#${CSS.escape(button.value)}`)!;
      const userText = this.messageDialogPopulatesPrompt
        ? message.querySelector<HTMLElement>(".agent-user")!.dataset.agentUserText!
        : undefined;
      this.closeMessageDialog();
      scrollMessageToTop(this.transcriptTarget, message);
      message.classList.add("agent-message-highlight");
      window.setTimeout(() => message.classList.remove("agent-message-highlight"), 1400);
      if (userText !== undefined) {
        this.setInputValue(userText);
        this.inputTarget.focus();
      }
    }

    // ---- prompt box ----

    inputKeydown(event: KeyboardEvent): void {
      const completionMenuOpen = Boolean(this.element.querySelector(".agent-completion-menu-host:not([hidden])"));
      const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      const atPromptStart = this.inputTarget.selectionStart === 0 && this.inputTarget.selectionEnd === 0;
      if (event.key === "ArrowUp" && noModifiers && !completionMenuOpen && atPromptStart && this.userMessages().length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.showMessageDialog(true);
        return;
      }

      // Enter inserts a newline; ⌘/Ctrl+Enter sends (or follow-ups when busy).
      if (isSubmitShortcut(event)) {
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

    private setInputValue(value: string): void {
      setTextInputValue(this.inputTarget, value);
    }

    promptChanged(): void {
      const value = this.inputTarget.value;
      if (value) sessionStorage.setItem(this.promptDraftStorageKey, value);
      else sessionStorage.removeItem(this.promptDraftStorageKey);
      this.autosize();
    }

    private get promptDraftStorageKey(): string {
      return `atelier.agentPromptDraft:${JSON.stringify([this.workspaceIdValue, this.labelValue])}`;
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
      this.updateSendStopButton();
    }

    updateSendStopButton(): void {
      const button = this.formTarget.querySelector<HTMLButtonElement>(".agent-sendstop");
      if (!button) return;
      const busy = button.dataset.agentBusy === "true";
      const empty = this.inputTarget.value.trim().length === 0;
      if (busy && empty) {
        button.dataset.mode = "stop";
        button.type = "submit";
        button.removeAttribute("name");
        button.removeAttribute("value");
        button.setAttribute("form", button.dataset.agentAbortFormId ?? "");
        button.title = "Agent is working — click to stop";
        button.setAttribute("aria-label", button.title);
        return;
      }
      button.dataset.mode = "send";
      button.type = "submit";
      button.name = "mode";
      button.value = busy ? "steer" : "send";
      button.removeAttribute("form");
      button.title = busy ? "Deliver a steering note while the agent keeps working" : "Send prompt";
      button.setAttribute("aria-label", button.title);
    }

    submitted(event: Event): void {
      const detail = (event as CustomEvent).detail as { success?: boolean } | undefined;
      if (detail?.success === false) return;
      this.setInputValue("");
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

    rewindPickOption(event: Event): void {
      const control = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      const label = control?.closest(".agent-rewind-opt");
      const radio = label?.querySelector<HTMLInputElement>("input[type=radio]");
      if (radio) radio.checked = true;
    }

    rewindSubmitted(): void {
      // Close immediately on submit; the rewind itself streams in via cable
      // (summaries behave like a busy agent with a stop button).
      this.rewindDialogTarget.close();
      if (this.rewindUserText && !this.inputTarget.value.trim()) {
        this.setInputValue(this.rewindUserText);
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
        const max = this.hasMaxValue && this.maxValue > 0 ? ` / ${format(this.maxValue)}` : "";
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
// Clipboard feedback
// ---------------------------------------------------------------------------

type CopiedFeedbackOptions = {
  iconSelector: string;
  copiedLabel: string;
  resetLabel: string;
  resetIcon: string;
  timer?: ReturnType<typeof setTimeout>;
};

function flashCopied(button: HTMLButtonElement, options: CopiedFeedbackOptions): ReturnType<typeof setTimeout> {
  if (options.timer) clearTimeout(options.timer);
  button.classList.add("copied");
  button.setAttribute("aria-label", options.copiedLabel);
  const icon = button.querySelector<HTMLElement>(options.iconSelector);
  if (icon) icon.textContent = "✓";
  return setTimeout(() => {
    button.classList.remove("copied");
    button.setAttribute("aria-label", options.resetLabel);
    if (icon) icon.textContent = options.resetIcon;
  }, 1400);
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
      const checked = tool?.querySelector<HTMLInputElement>('.agent-region-tabs input:checked, .agent-observed-tabs input:checked');
      const pane = checked?.id.endsWith("-model")
        ? tool?.querySelector<HTMLElement>(".model-pane, .agent-observed-model")
        : checked?.id.endsWith("-live")
          ? tool?.querySelector<HTMLElement>(".agent-observed-live")
          : tool?.querySelector<HTMLElement>(".result-pane, .agent-observed-result");
      const result = pane?.querySelector<HTMLElement>(".agent-tool-result, .xterm-rows") ?? tool?.querySelector<HTMLElement>(".agent-tool-result, .xterm-rows");
      const text = result?.textContent ?? "";
      if (!text) return;
      await copyTextToClipboard(text);
      this.timer = flashCopied(this.element, {
        iconSelector: ".agent-tool-copy-icon",
        copiedLabel: "Copied bash output",
        resetLabel: "Copy bash output to clipboard",
        resetIcon: "⧉",
        timer: this.timer,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// agent-code-copy: copy markdown code blocks to clipboard
// ---------------------------------------------------------------------------

function createAgentCodeCopyController(Controller: StimulusControllerConstructor) {
  return class AgentCodeCopyController extends Controller {
    static targets = ["code"];
    declare readonly element: HTMLElement;
    declare readonly codeTarget: HTMLElement;
    private timer?: ReturnType<typeof setTimeout>;

    disconnect(): void {
      if (this.timer) clearTimeout(this.timer);
    }

    async copy(event: Event): Promise<void> {
      event.preventDefault();
      const button = event.currentTarget as HTMLButtonElement;
      const text = this.codeTarget.textContent ?? "";
      if (!text) return;
      await copyTextToClipboard(text);
      const label = button.dataset.resetLabel ?? button.getAttribute("aria-label") ?? "Copy code to clipboard";
      button.dataset.resetLabel = label;
      this.timer = flashCopied(button, {
        iconSelector: ".agent-code-copy-icon",
        copiedLabel: "Copied code",
        resetLabel: label,
        resetIcon: "⧉",
        timer: this.timer,
      });
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
// HTML autocomplete: server-rendered menu + shared keyboard/pointer behavior
// ---------------------------------------------------------------------------

export function createHtmlAutocompleteController(Controller: StimulusControllerConstructor, autocomplete: HtmlAutocompleteOptions) {
  return class HtmlAutocompleteController extends Controller {
    static values = { url: String };
    static targets = ["input", "menu"];
    declare readonly element: HTMLElement;
    declare readonly urlValue: string;
    declare readonly inputTarget: HTMLInputElement | HTMLTextAreaElement;
    declare readonly menuTarget: HTMLElement;
    private requestId = 0;
    private optionId = 0;
    private debounceTimer: number | undefined;
    private form: HTMLFormElement | null = null;
    private interaction = {};

    connect(): void {
      this.form = this.inputTarget.closest("form");
      this.menuTarget.addEventListener("click", this.click);
      this.menuTarget.addEventListener("pointerdown", this.pointerdown);
      this.menuTarget.addEventListener("pointerover", this.pointerover);
      for (const type of ["input", "change", "keydown"]) this.menuTarget.addEventListener(type, this.menuEvent);
      this.inputTarget.addEventListener("blur", this.blur);
      this.form?.addEventListener("submit", this.submitted);
      document.addEventListener("selectionchange", this.selectionchange);
    }

    disconnect(): void {
      this.menuTarget.removeEventListener("click", this.click);
      this.menuTarget.removeEventListener("pointerdown", this.pointerdown);
      this.menuTarget.removeEventListener("pointerover", this.pointerover);
      for (const type of ["input", "change", "keydown"]) this.menuTarget.removeEventListener(type, this.menuEvent);
      this.inputTarget.removeEventListener("blur", this.blur);
      this.form?.removeEventListener("submit", this.submitted);
      document.removeEventListener("selectionchange", this.selectionchange);
      window.clearTimeout(this.debounceTimer);
    }

    input(): void {
      this.scheduleRefresh();
    }

    keydown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      if (autocomplete.keydown?.(event, this.inputTarget, this.urlValue, {
        open: !this.menuTarget.hidden,
        hasOptions: this.options().length > 0,
        activeOption: () => this.activeOption(),
        select: (option) => this.insert(option),
        setInputValue: (value) => setTextInputValue(this.inputTarget, value),
        close: () => this.close(),
        refresh: (force = false) => this.scheduleRefresh(force),
      })) return;
      if (this.menuTarget.hidden) {
        if (autocomplete.triggerKeysWhenClosed?.includes(event.key)) requestAnimationFrame(() => this.scheduleRefresh());
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.moveTo(event.key === "Home" ? 0 : this.options().length - 1);
        return;
      }
      if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const active = this.activeOption();
        const fullscreen = active && (typeof autocomplete.fullscreenShortcut === "function" ? autocomplete.fullscreenShortcut(active) : autocomplete.fullscreenShortcut);
        if (!fullscreen) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        const active = this.activeOption();
        if (!active) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.insert(active);
      }
    }

    private scheduleRefresh(force = false): void {
      window.clearTimeout(this.debounceTimer);
      this.requestId++;
      const request = autocomplete.request(this.inputTarget, force);
      if (!request) {
        this.close();
        return;
      }
      if (autocomplete.loadingHtml && this.menuTarget.hidden) {
        this.menuTarget.innerHTML = autocomplete.loadingHtml;
        this.menuTarget.hidden = false;
      }
      const debounceMs = force ? 0 : request.debounceMs ?? 0;
      if (debounceMs === 0) {
        void this.refresh(request);
        return;
      }
      this.debounceTimer = window.setTimeout(() => void this.refresh(request), debounceMs);
    }

    private readonly click = (event: Event): void => {
      if (autocomplete.menuEvent?.(event, this.inputTarget)) {
        event.preventDefault();
        return;
      }
      const option = this.optionFromEvent(event);
      if (!option) return;
      event.preventDefault();
      this.insert(option);
    };

    private readonly pointerdown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      if (autocomplete.menuEvent?.(event, this.inputTarget)) {
        event.preventDefault();
        return;
      }
      const option = this.optionFromEvent(event);
      if (!option) return;
      event.preventDefault();
      // WebKit cancels click after a prevented touch pointerdown, so select immediately.
      if (event.pointerType === "touch") this.insert(option);
    };

    private readonly pointerover = (event: Event): void => {
      const option = this.optionFromEvent(event);
      if (option) this.activate(option, false);
    };

    private optionFromEvent(event: Event): HTMLElement | null {
      return event.target instanceof Element ? event.target.closest<HTMLElement>(autocomplete.optionSelector) : null;
    }

    private readonly menuEvent = (event: Event): void => {
      autocomplete.menuEvent?.(event, this.inputTarget);
    };

    private readonly blur = (event: Event): void => {
      const relatedTarget = (event as FocusEvent).relatedTarget;
      if (relatedTarget instanceof Node && this.menuTarget.contains(relatedTarget)) return;
      this.close();
    };

    private readonly submitted = (): void => this.close();

    private readonly selectionchange = (): void => {
      if (this.menuTarget.hidden || document.activeElement !== this.inputTarget || agentTreeOwnsMenu(this.menuTarget)) return;
      this.scheduleRefresh();
    };

    private async refresh(request: HtmlAutocompleteRequest): Promise<void> {
      const id = ++this.requestId;
      const url = new URL(this.urlValue, window.location.href);
      url.searchParams.set("q", request.query);
      for (const [name, value] of Object.entries(request.params ?? {})) url.searchParams.set(name, value);
      const html = await (autocomplete.loadHtml?.(request, url, this.interaction)
        ?? fetch(url, { headers: { Accept: "text/html" } }).then((response) => response.text()));
      if (id !== this.requestId) return;
      this.menuTarget.innerHTML = html;
      this.menuTarget.hidden = false;
      const active = this.activeOption();
      if (active) this.activate(active, false);
    }

    private close(): void {
      this.requestId++;
      window.clearTimeout(this.debounceTimer);
      this.menuTarget.hidden = true;
      this.inputTarget.removeAttribute("aria-activedescendant");
      this.menuTarget.replaceChildren();
      this.interaction = {};
    }

    private options(): HTMLElement[] {
      return [...this.menuTarget.querySelectorAll<HTMLElement>(autocomplete.optionSelector)];
    }

    private activeOption(): HTMLElement | undefined {
      return this.menuTarget.querySelector<HTMLElement>(`${autocomplete.optionSelector}.active`) ?? this.options()[0];
    }

    private activate(option: HTMLElement, scroll = true): void {
      for (const candidate of this.options()) {
        const active = candidate === option;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-selected", active ? "true" : "false");
      }
      option.id ||= `${this.element.id || "html-autocomplete"}-option-${++this.optionId}`;
      this.inputTarget.setAttribute("aria-activedescendant", option.id);
      if (scroll) option.scrollIntoView({ block: "nearest" });
    }

    private move(delta: number): void {
      const options = this.options();
      if (options.length === 0) return;
      const current = this.activeOption();
      const index = current ? options.indexOf(current) : 0;
      this.activate(options[(index + delta + options.length) % options.length]);
    }

    private moveTo(index: number): void {
      const options = this.options();
      const option = options[index];
      if (option) this.activate(option);
    }

    private insert(option: HTMLElement): void {
      if (autocomplete.select(option, this.inputTarget) === false) return;
      notifyInputListeners(this.inputTarget);
      this.close();
    }
  };
}

// ---------------------------------------------------------------------------
// agent-completions: slash resources, @ references, and explicit path completion
// ---------------------------------------------------------------------------

const filePathDelimiters = new Set([" ", "\t", "\n", "\r", '"', "'", "="]);

export interface AgentCompletionInput {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

function unclosedDoubleQuoteStart(text: string): number | undefined {
  let start: number | undefined;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') continue;
    start = start === undefined ? index : undefined;
  }
  return start;
}

export function fileCompletionPrefix(input: AgentCompletionInput): string {
  const cursor = input.selectionStart ?? 0;
  const lineStart = input.value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const before = input.value.slice(lineStart, cursor);
  const quoteStart = unclosedDoubleQuoteStart(before);
  let prefix: string;
  if (quoteStart !== undefined && (quoteStart === 0 || filePathDelimiters.has(before[quoteStart - 1]) || before[quoteStart - 1] === "@")) {
    const start = quoteStart > 0 && before[quoteStart - 1] === "@" ? quoteStart - 1 : quoteStart;
    prefix = before.slice(start);
  } else {
    let start = before.length;
    while (start > 0 && !filePathDelimiters.has(before[start - 1])) start--;
    prefix = before.slice(start);
  }

  return prefix;
}

function rawFileCompletionQuery(prefix: string): string {
  if (prefix.startsWith('@"')) return prefix.slice(2);
  if (prefix.startsWith("@") || prefix.startsWith('"')) return prefix.slice(1);
  return prefix;
}

export interface AgentCompletionRequest {
  kind: "slash-command" | "file";
  query: string;
  mode?: "direct" | "fuzzy";
}

export function agentCompletionRequest(input: AgentCompletionInput, force = false): AgentCompletionRequest | undefined {
  if (force) {
    const prefix = fileCompletionPrefix(input);
    return { kind: "file", query: rawFileCompletionQuery(prefix), mode: prefix.startsWith("@") ? "fuzzy" : "direct" };
  }

  const before = input.value.slice(0, input.selectionStart ?? 0);
  const after = input.value.slice(input.selectionEnd ?? 0);
  if (!after || /^\s/.test(after)) {
    const slash = before.match(/^\/([^/\s]*)$/);
    if (slash) return { kind: "slash-command", query: slash[1] };
  }

  const prefix = fileCompletionPrefix(input);
  return prefix.startsWith("@") ? { kind: "file", query: rawFileCompletionQuery(prefix), mode: "fuzzy" } : undefined;
}

export function insertSlashCommand(option: Pick<HTMLElement, "dataset">, input: AgentCompletionInput): void {
  const trigger = option.dataset.commandTrigger;
  if (!trigger) return;
  const end = input.selectionEnd ?? 0;
  const after = input.value.slice(end);
  input.value = `${trigger} ${after}`;
  input.setSelectionRange(trigger.length + 1, trigger.length + 1);
}

function insertFileCompletion(option: HTMLElement, input: AgentCompletionInput): void {
  const path = option.dataset.filePath;
  const prefix = fileCompletionPrefix(input);
  if (!path) return;
  const cursor = input.selectionStart ?? 0;
  const start = cursor - prefix.length;
  let after = input.value.slice(input.selectionEnd ?? cursor);
  const atPrefix = prefix.startsWith("@");
  const quotedPrefix = prefix.startsWith('"') || prefix.startsWith('@"');
  const needsQuotes = quotedPrefix || path.includes(" ");
  const value = `${atPrefix ? "@" : ""}${needsQuotes ? `"${path}"` : path}`;
  if (needsQuotes && after.startsWith('"')) after = after.slice(1);
  const directory = option.dataset.fileDirectory === "true";
  const suffix = atPrefix && !directory ? " " : "";
  input.value = `${input.value.slice(0, start)}${value}${suffix}${after}`;
  let nextCursor = start + value.length + suffix.length;
  if (directory && needsQuotes) nextCursor--;
  input.setSelectionRange(nextCursor, nextCursor);
}

interface SlashCatalogCacheEntry {
  html?: string;
  refresh?: Promise<string>;
}

const slashCatalogCache = new Map<string, SlashCatalogCacheEntry>();
const slashCatalogSnapshots = new WeakMap<object, string>();

function slashCatalogUrl(completionsUrl: string | URL): URL {
  const url = new URL(completionsUrl, window.location.href);
  const workspacePath = url.pathname.match(/^\/workspaces\/[^/]+/)![0];
  url.pathname = `${workspacePath}/completion-catalog`;
  url.search = "";
  return url;
}

function refreshSlashCatalog(completionsUrl: string | URL): Promise<string> {
  const catalogUrl = slashCatalogUrl(completionsUrl);
  const key = catalogUrl.href;
  const entry = slashCatalogCache.get(key) ?? {};
  slashCatalogCache.set(key, entry);
  if (entry.refresh) return entry.refresh;

  entry.refresh = fetch(catalogUrl, { headers: { Accept: "text/html" } })
    .then((response) => response.text())
    .then((html) => {
      entry.html = html;
      entry.refresh = undefined;
      return html;
    }, (error) => {
      entry.refresh = undefined;
      throw error;
    });
  return entry.refresh;
}

function filterSlashCompletionCatalog(html: string, query: string): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  const menu = container.content.querySelector<HTMLElement>(".agent-completion-menu")!;
  const normalized = query.toLowerCase();
  const options = [...menu.querySelectorAll<HTMLElement>(".agent-completion-option")]
    .filter((option) => option.dataset.commandTrigger!.slice(1).toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.dataset.commandTrigger!.slice(1).toLowerCase();
      const bName = b.dataset.commandTrigger!.slice(1).toLowerCase();
      return Number(bName.startsWith(normalized)) - Number(aName.startsWith(normalized)) || aName.localeCompare(bName);
    })
    .slice(0, 12);

  if (options.length === 0) return `<div class="agent-completion-menu empty">No slash commands</div>`;
  menu.replaceChildren(...options);
  for (const [index, option] of options.entries()) {
    option.classList.toggle("active", index === 0);
    option.setAttribute("aria-selected", index === 0 ? "true" : "false");
  }
  return menu.outerHTML;
}

async function slashCompletionHtml(url: URL, interaction: HtmlAutocompleteInteraction, query: string): Promise<string> {
  let catalog = slashCatalogSnapshots.get(interaction);
  if (!catalog) {
    const entry = slashCatalogCache.get(slashCatalogUrl(url).href);
    if (entry?.html) {
      catalog = entry.html;
      void refreshSlashCatalog(url);
    } else {
      catalog = await refreshSlashCatalog(url);
    }
    slashCatalogSnapshots.set(interaction, catalog);
  }
  return filterSlashCompletionCatalog(catalog, query);
}

function createAgentCompletionsController(Controller: StimulusControllerConstructor) {
  const HtmlAutocompleteController = createHtmlAutocompleteController(Controller, {
    optionSelector: ".agent-completion-option:not([hidden])",
    loadingHtml: `<div class="agent-completion-menu empty" role="status"><span class="agent-completion-spinner" aria-hidden="true"></span>Loading completions…</div>`,
    triggerKeysWhenClosed: ["/", "@"],
    fullscreenShortcut: (option) => option.dataset.completionKind === "prompt-template",
    menuEvent: handleAgentTreeMenuEvent,
    request(input, force) {
      const completion = agentCompletionRequest(input, force);
      if (!completion) return completion;
      interface CompletionRequestParams {
        [name: string]: string;
        kind: typeof completion.kind;
      }
      const params: CompletionRequestParams = { kind: completion.kind };
      if (completion.mode) params["mode"] = completion.mode;
      return { query: completion.query, params, debounceMs: completion.kind === "file" ? 70 : 0 };
    },
    loadHtml(request, url, interaction) {
      if (request.params?.kind === "slash-command") return slashCompletionHtml(url, interaction, request.query);
    },
    select(option, input) {
      if (selectAgentTreeOption(option, input)) return false;
      if (option.dataset.commandTrigger) insertSlashCommand(option, input);
      else if (option.dataset.completionKind === "file") insertFileCompletion(option, input);
    },
    keydown(event, input, url, actions) {
      const send = isSubmitShortcut(event);
      const expand = event.key === "Enter" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (handleAgentTreeKeydown(event, input, actions)) return true;
      if (send || expand) {
        const active = actions.open ? actions.activeOption() : undefined;
        if (active?.dataset.commandTrigger) actions.select(active);
        if (send || !/^\/[^/\s]+(?:\s+[\s\S]*)?$/.test(input.value.trim())) return false;
        event.preventDefault();
        const body = new FormData();
        body.set("text", input.value);
        void fetch(`${url}/prompt-template-expand`, { method: "POST", body, headers: { Accept: "text/plain" } })
          .then((response) => response.text())
          .then((expanded) => {
            actions.setInputValue(expanded);
            actions.close();
          });
        return true;
      }
      if (event.key !== "Tab" || event.metaKey || event.ctrlKey || event.altKey || (actions.open && actions.hasOptions)) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.refresh(true);
      return true;
    },
  });

  return class AgentCompletionsController extends HtmlAutocompleteController {
    connect(): void {
      super.connect();
      void refreshSlashCatalog(this.urlValue);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-attachments: drag & drop + uploads with progress chips
// ---------------------------------------------------------------------------

let dropGuardInstalled = false;

function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function clearAgentDropTargets(): void {
  document.querySelectorAll<HTMLElement>(".agent-dropping").forEach((element) => element.classList.remove("agent-dropping"));
}

function installDropGuard(): void {
  if (dropGuardInstalled) return;
  dropGuardInstalled = true;
  // Never let a stray file drop navigate the app away.
  window.addEventListener("dragover", (event) => {
    if (dragHasFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (dragHasFiles(event)) event.preventDefault();
    clearAgentDropTargets();
  });
  window.addEventListener("dragend", clearAgentDropTargets);
}

function createAgentAttachmentsController(Controller: StimulusControllerConstructor) {
  return class AgentAttachmentsController extends Controller {
    static values = { uploadUrl: String };
    static targets = ["row"];
    declare readonly element: HTMLElement;
    declare readonly uploadUrlValue: string;
    declare readonly rowTarget: HTMLElement;

    connect(): void {
      installDropGuard();
    }

    dragOver(event: DragEvent): void {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.element.classList.add("agent-dropping");
    }

    dragLeave(event: DragEvent): void {
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (next && this.element.contains(next)) return;
      this.element.classList.remove("agent-dropping");
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
// agent-thinking: clamp long thinking text until the reader opens it
// ---------------------------------------------------------------------------

function createAgentThinkingController(Controller: StimulusControllerConstructor) {
  return class AgentThinkingController extends Controller {
    static targets = ["content", "preview", "more"];
    declare readonly element: HTMLElement;
    declare readonly contentTarget: HTMLElement;
    declare readonly previewTarget: HTMLElement;
    declare readonly moreTarget: HTMLElement;
    private observer?: MutationObserver;
    private resizeObserver?: ResizeObserver;
    private measureFrame?: number;
    private expanded = false;
    private fullText = "";

    connect(): void {
      this.observer = new MutationObserver(() => this.measure());
      this.observer.observe(this.contentTarget, { childList: true, characterData: true, subtree: true });
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(this.element);
      this.measure();
    }

    disconnect(): void {
      this.observer?.disconnect();
      this.resizeObserver?.disconnect();
      if (this.measureFrame) cancelAnimationFrame(this.measureFrame);
    }

    expand(): void {
      if (!this.element.classList.contains("truncated")) return;
      this.expanded = true;
      this.element.classList.remove("truncated");
      this.element.classList.add("expanded");
      this.contentTarget.hidden = true;
      this.previewTarget.textContent = this.fullText;
      this.previewTarget.hidden = false;
      this.moreTarget.hidden = true;
      this.element.removeAttribute("role");
      this.element.removeAttribute("tabindex");
    }

    keydown(event: KeyboardEvent): void {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.expand();
    }

    private measure(): void {
      if (this.expanded) return;
      if (this.measureFrame) cancelAnimationFrame(this.measureFrame);
      this.measureFrame = requestAnimationFrame(() => {
        this.measureFrame = undefined;
        this.fullText = (this.contentTarget.textContent ?? "").trimEnd();
        this.contentTarget.hidden = true;
        this.previewTarget.textContent = this.fullText;
        this.previewTarget.hidden = false;
        this.moreTarget.hidden = true;
        this.element.classList.remove("truncated");

        const lineHeight = Number.parseFloat(getComputedStyle(this.element).lineHeight);
        const maxHeight = lineHeight * 2;
        if (this.element.scrollHeight <= maxHeight + 1) {
          this.element.removeAttribute("role");
          this.element.removeAttribute("tabindex");
          return;
        }

        this.moreTarget.hidden = false;
        this.element.classList.add("truncated");

        let low = 0;
        let high = this.fullText.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          this.previewTarget.textContent = this.fullText.slice(0, middle).trimEnd();
          if (this.element.scrollHeight <= maxHeight + 1) low = middle;
          else high = middle - 1;
        }
        let preview = this.fullText.slice(0, low).trimEnd();
        // Leave breathing room so the affordance reads as part of the prose,
        // rather than landing against the text's right edge.
        for (let words = 0; words < 4; words++) {
          const wordBoundary = preview.search(/\s+\S+$/);
          if (wordBoundary < 0) break;
          preview = preview.slice(0, wordBoundary).trimEnd();
        }
        this.previewTarget.textContent = preview;
        this.element.setAttribute("role", "button");
        this.element.setAttribute("tabindex", "0");
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Lazy transcript details and paginated tail preservation
// ---------------------------------------------------------------------------

function createAgentTailFrameController(Controller: StimulusControllerConstructor) {
  return class AgentTailFrameController extends Controller {
    declare readonly element: HTMLElement;
    private previous?: {
      scrollerIndex: number;
      height: number;
      top: number;
      tail: boolean;
      checkedTabs: string[];
      transcript?: { element: HTMLElement; top: number };
    };
    private scrollers(): HTMLElement[] {
      return [...this.element.querySelectorAll<HTMLElement>(".agent-tail-output")];
    }
    prepare(event: Event): void {
      const target = event.currentTarget as HTMLElement;
      const scrollers = this.scrollers();
      const scroller = target.closest<HTMLElement>(".agent-tail-output") ?? scrollers[0];
      if (!scroller) return;
      const transcript = this.element.closest<HTMLElement>(".agent-transcript");
      this.previous = {
        scrollerIndex: scrollers.indexOf(scroller),
        height: scroller.scrollHeight,
        top: scroller.scrollTop,
        tail: target.dataset.direction === "last",
        checkedTabs: [...this.element.querySelectorAll<HTMLInputElement>(".agent-region-tabs input:checked, .agent-observed-tabs input:checked")].map((input) => input.id),
        transcript: transcript ? { element: transcript, top: transcript.scrollTop } : undefined,
      };
    }
    loaded(): void {
      const previous = this.previous;
      this.previous = undefined;
      if (!previous) {
        for (const scroller of this.element.querySelectorAll<HTMLElement>('.agent-tail-output[data-agent-tail-direction="last"]')) scroller.scrollTop = scroller.scrollHeight;
        return;
      }
      for (const input of this.element.querySelectorAll<HTMLInputElement>(".agent-region-tabs input, .agent-observed-tabs input")) {
        if (previous.checkedTabs.includes(input.id)) input.checked = true;
      }
      const scroller = this.scrollers()[previous.scrollerIndex];
      if (!scroller) return;
      scroller.scrollTop = previous.tail ? previous.top + scroller.scrollHeight - previous.height : previous.top;
      if (previous.transcript) {
        // Keep pagination from activating native anchoring or stick-to-bottom.
        previous.transcript.element.scrollTop = previous.transcript.top;
        previous.transcript.element.dispatchEvent(new Event("scroll"));
      }
    }
  };
}

function createAgentLazyDetailController(Controller: StimulusControllerConstructor) {
  return class AgentLazyDetailController extends Controller {
    static targets = ["frame"];
    declare readonly element: HTMLDetailsElement;
    declare readonly frameTarget: HTMLElement & { src: string };

    connect(): void { if (this.element.open) this.load(); }
    load(): void {
      if (!this.element.open || this.frameTarget.getAttribute("src")) return;
      this.frameTarget.setAttribute("src", this.frameTarget.dataset.src!);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-term: inline read-only xterm attached to an agent tmux session
// ---------------------------------------------------------------------------

export function forwardAgentTerminalWheel<T extends Pick<HTMLElement, "scrollTop" | "clientHeight">>(
  terminal: { closest(selectors: string): T | null },
  event: Pick<WheelEvent, "ctrlKey" | "deltaY" | "deltaMode" | "preventDefault" | "stopPropagation"> & {
    readonly DOM_DELTA_LINE: number;
    readonly DOM_DELTA_PAGE: number;
  },
): boolean {
  const transcript = terminal.closest(".agent-transcript");
  if (!transcript || event.ctrlKey || event.deltaY === 0) return false;
  const delta = event.deltaMode === event.DOM_DELTA_LINE
    ? event.deltaY * 16
    : event.deltaMode === event.DOM_DELTA_PAGE
      ? event.deltaY * transcript.clientHeight
      : event.deltaY;
  transcript.scrollTop += delta;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function createAgentTermController(Controller: StimulusControllerConstructor) {
  return class AgentTermController extends Controller {
    static values = { workspaceId: String, label: String, session: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly sessionValue: string;
    private viewer?: ObservableTerminalViewer;
    private disposed = false;
    private starting = false;

    private theme(): ObservableTerminalTheme {
      const terminalStyle = getComputedStyle(this.element);
      return {
        ...atelierObservableTerminalTheme(),
        background: terminalStyle.backgroundColor,
        foreground: terminalStyle.color,
      };
    }

    private themeChanged = (): void => {
      this.viewer?.setTheme(this.theme());
    };

    private wheel = (event: WheelEvent): void => {
      forwardAgentTerminalWheel(this.element, event);
    };

    connect(): void {
      this.disposed = false;
      document.addEventListener("atelier:theme-change", this.themeChanged);
      this.element.addEventListener("wheel", this.wheel, { capture: true, passive: false });
      if (isWorkspacePaneVisible(this.element)) this.start();
    }

    start(): void {
      if (this.viewer || this.starting) return;
      this.disposed = false;
      this.starting = true;
      const decoder = new TextDecoder();
      let hasVisibleOutput = false;
      void createObservableTerminalViewer({
        host: this.element,
        mode: "fixed-readonly",
        cols: 120,
        rows: 30,
        websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agent-term/${encodeURIComponent(this.sessionValue)}/ws?cols=120&rows=30`),
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
        theme: this.theme(),
        onOutput: (data) => {
          if (hasVisibleOutput) return;
          const text = typeof data === "string" ? data : decoder.decode(data, { stream: true });
          const printable = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
          if (!printable) return;
          hasVisibleOutput = true;
          this.element.classList.remove("agent-terminal-awaiting-output");
        },
        onClose: () => {
          if (hasVisibleOutput) return;
          const selectResult = () => {
            const result = this.element.closest(".agent-observed-bash")?.querySelector<HTMLInputElement>('.agent-observed-tabs input[id$="-result"]');
            if (result) result.checked = true;
            else if (this.element.isConnected) setTimeout(selectResult, 25);
          };
          selectResult();
        },
      })
        .then((viewer) => {
          if (this.disposed) viewer.dispose();
          else this.viewer = viewer;
        })
        // Terminal startup crosses browser and extension APIs that may reject with
        // arbitrary values. This final UI boundary converts the reason to inert text.
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- No Error shape is assumed.
        .catch((error: unknown) => {
          this.element.textContent = `[terminal attach failed: ${error instanceof Error ? error.message : String(error)}]`;
        })
        .finally(() => {
          this.starting = false;
        });
    }

    disconnect(): void {
      this.disposed = true;
      document.removeEventListener("atelier:theme-change", this.themeChanged);
      this.element.removeEventListener("wheel", this.wheel, { capture: true });
      this.viewer?.dispose();
      this.viewer = undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// Tab visibility hook
// ---------------------------------------------------------------------------

function agentPaneController(application: StimulusApplication, pane: HTMLElement): AgentPaneControllerInstance | null {
  const agentPane = pane.querySelector<HTMLElement>('[data-controller~="agent-pane"]');
  return agentPane ? application.getControllerForElementAndIdentifier(agentPane, "agent-pane") as AgentPaneControllerInstance | null : null;
}

export function focusAgentPrompt(pane?: { querySelector(selectors: string): Pick<HTMLTextAreaElement, "focus"> | null } | null): boolean {
  const input = pane?.querySelector(".agent-input");
  if (!input) return false;
  input.focus({ preventScroll: true });
  return true;
}

function agentTabBecameVisible(application: StimulusApplication, pane: HTMLElement): void {
  agentPaneController(application, pane)?.start();
  focusAgentPrompt(pane);
}

function agentTabNoLongerVisible(application: StimulusApplication, pane: HTMLElement): void {
  agentPaneController(application, pane)?.stop();
}

async function waitForAgentResident(workspaceId: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const resident = document.querySelector<HTMLElement>(`.workspace-detail-resident.visible[data-workspace-id="${CSS.escape(workspaceId)}"]`);
    if (resident) return resident;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Workspace ${workspaceId} did not become visible`);
}

async function openAgentSession(workspaceId: string, tabKey: string): Promise<void> {
  const visible = document.querySelector<HTMLElement>(`.workspace-detail-resident.visible[data-workspace-id="${CSS.escape(workspaceId)}"]`);
  if (!visible) {
    const row = document.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"]`);
    row?.querySelector<HTMLAnchorElement>("a.row-main")?.click();
  }
  const resident = await waitForAgentResident(workspaceId);
  resident.querySelector<HTMLButtonElement>(`.group-tab[data-tab="${CSS.escape(tabKey)}"] .group-tab-label`)?.click();
  const pane = resident.querySelector<HTMLElement>(`.tab-pane[data-tab-pane="${CSS.escape(tabKey)}"]`);
  const input = pane?.querySelector<HTMLTextAreaElement>(".agent-input");
  input?.focus();
}

function agentPaletteItems(fuzzyScore: (candidate: string) => number): WorkspacePaletteItem[] {
  return [...document.querySelectorAll<HTMLElement>(".agent-pane")].map((pane) => {
    const workspaceId = pane.dataset.agentPaneWorkspaceIdValue!;
    const label = pane.dataset.agentPaneLabelValue!;
    const resident = pane.closest<HTMLElement>(".workspace-detail-resident[data-workspace-id]");
    const workspaceTitle = document.querySelector<HTMLElement>(`.workspace-row[data-workspace-id="${CSS.escape(workspaceId)}"] .r-title`)?.textContent?.trim() ?? workspaceId;
    const tabKey = pane.closest<HTMLElement>(".tab-pane[data-tab-pane]")?.dataset.tabPane ?? `agent:${label}`;
    const busy = pane.querySelector<HTMLElement>(".agent-sendstop[data-agent-busy='true']") ? "busy" : "idle";
    const transcript = pane.querySelector<HTMLElement>(".agent-transcript")?.textContent?.trim().replace(/\s+/g, " ") ?? "";
    const tail = transcript.slice(-600);
    const score = fuzzyScore([label, workspaceTitle, busy, tail].join(" ")) + (resident?.classList.contains("visible") ? 20 : 0) + (busy === "busy" ? 12 : 0);
    return {
      id: `agent:${workspaceId}:${label}`,
      title: label,
      subtitle: workspaceTitle,
      detail: tail.length > 140 ? `…${tail.slice(-140)}` : tail,
      badge: busy,
      keywords: [workspaceId, tabKey, busy],
      score,
      run: () => openAgentSession(workspaceId, tabKey),
    };
  });
}

export const agentClientModule: WorkspaceClientModule = {
  id: "agent",
  install({ application, Controller, hooks }) {
    application.register("agent-pane", createAgentPaneController(Controller));
    application.register("agent-attachments", createAgentAttachmentsController(Controller));
    application.register("agent-autosubmit", createAgentAutosubmitController(Controller));
    application.register("agent-code-copy", createAgentCodeCopyController(Controller));
    application.register("agent-copy", createAgentCopyController(Controller));
    application.register("agent-elapsed", createAgentElapsedController(Controller));
    application.register("agent-html-preview", createAgentHtmlPreviewController(Controller));
    application.register("agent-thinking", createAgentThinkingController(Controller));
    application.register("agent-tail-frame", createAgentTailFrameController(Controller));
    application.register("agent-lazy-detail", createAgentLazyDetailController(Controller));
    application.register("agent-notice", createAgentNoticeController(Controller));
    application.register("agent-completions", createAgentCompletionsController(Controller));
    application.register("agent-proxy", createAgentProxyController(Controller));
    application.register("agent-term", createAgentTermController(Controller));

    hooks.registerPaletteProvider({
      id: "agent.sessions",
      label: "Agent session",
      search: ({ fuzzyScore }) => agentPaletteItems(fuzzyScore),
    });
    hooks.onBecomeVisible(({ pane }) => agentTabBecameVisible(application, pane));
    hooks.onNoLongerVisible(({ pane }) => agentTabNoLongerVisible(application, pane));
    hooks.onFocusGroup(({ pane }) => focusAgentPrompt(pane));
    hooks.onWorkspaceCommand((commandId) => {
      if (commandId !== "agent.launch-project-workspace") return false;
      const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.visible");
      const projectId = resident?.dataset.projectId;
      if (!projectId) return true;
      const frame = document.getElementById("agent_launch_modal")!;
      frame.replaceChildren();
      frame.removeAttribute("src");
      frame.setAttribute("src", `/projects/${encodeURIComponent(projectId)}/agent-launch`);
      return true;
    });
  },
};
