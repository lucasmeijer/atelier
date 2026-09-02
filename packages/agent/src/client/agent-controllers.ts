/// <reference lib="dom" />

import { setActivityButtonState } from "@atelier/design-system/activity-button/client";
import { atelierObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalTheme, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import { CableTopics, composerSubmitKey, copyTextToClipboard, focusLikelyOpensSoftwareKeyboard, notifyInputListeners, recentWorkspaceProjectStorageKey, setTextInputValue, workspaceProxyUrl, type AtelierCableClient, type CableIdentifier, type CableSubscriptionOptions, type WorkspaceClientCommand, type WorkspaceClientController, type WorkspaceClientHooks, type WorkspaceClientModule } from "@atelier/shared";
import { agentTreeOwnsMenu, handleAgentTreeKeydown, handleAgentTreeMenuEvent, selectAgentTreeOption } from "./session-tree.ts";

type StimulusControllerConstructor = new (...args: never[]) => { element: Element };
type TurboSubmitEndEvent = CustomEvent<{ success: boolean; fetchResponse?: { response: Response } }>;

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
  select(option: HTMLElement, input: HTMLInputElement | HTMLTextAreaElement, url: string): boolean | void;
  keydown?(event: KeyboardEvent, input: HTMLInputElement | HTMLTextAreaElement, url: string, actions: HtmlAutocompleteActions): boolean;
  loadingHtml?: string;
  triggerKeysWhenClosed?: string[];
  fullscreenShortcut?(option: HTMLElement): boolean;
  keepOpenOnBlur?(input: HTMLInputElement | HTMLTextAreaElement, menu: HTMLElement): boolean;
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
  becomeVisible(): void;
  noLongerVisible(): void;
  terminalConnected(terminal: AgentTermControllerInstance): void;
}

interface AgentTermControllerInstance {
  start(): void;
  stop(): void;
}

function agentTermController(application: StimulusApplication, terminal: HTMLElement): AgentTermControllerInstance | null {
  const controller = application.getControllerForElementAndIdentifier(terminal, "agent-term");
  // SAFETY: This module registers AgentTermController under "agent-term"; Stimulus
  // returns that registered controller for this exact element-and-identifier pair.
  return controller as AgentTermControllerInstance | null;
}

// ---------------------------------------------------------------------------
// agent-pane: cable subscription lifecycle, scroll anchoring, and prompt behavior
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

export function workspaceSelectionScrollTop(transcript: ScrollTranscript, target: TranscriptMessage | null, busy: boolean): number {
  if (busy) return scrollEnd(transcript);
  return target ? messageScrollTarget(transcript, target) : 0;
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

export function agentConnectionShouldRun(logicallyVisible: boolean, documentVisibility: DocumentVisibilityState): boolean {
  return logicallyVisible && documentVisibility === "visible";
}

export function agentComposerTextStorageKey(workspaceId: string, conversationId: string): string {
  return `atelier.agentComposerText:${JSON.stringify([workspaceId, conversationId])}`;
}

export function shouldPositionTranscriptAfterSnapshot(hasBeenReady: boolean, selectedSinceLastReady: boolean): boolean {
  return !hasBeenReady || selectedSinceLastReady;
}

export function agentComposerPrimaryAction(busy: boolean, text: string, attachmentCount: number): "abort" | "send" | "steer" {
  if (!busy) return "send";
  return text.trim().length > 0 || attachmentCount > 0 ? "steer" : "abort";
}

export type PromptHistoryState = { prompts: string[]; draft: string; index: number };

export function navigatePromptHistory(state: PromptHistoryState | undefined, direction: "up" | "down", draft: string, prompts: string[]): { state: PromptHistoryState | undefined; value: string } | undefined {
  if (!state) {
    if (direction === "down" || prompts.length === 0) return undefined;
    const next = { prompts, draft, index: prompts.length - 1 };
    return { state: next, value: prompts[next.index] };
  }
  if (direction === "up") {
    const next = { ...state, index: Math.max(0, state.index - 1) };
    return { state: next, value: next.prompts[next.index] };
  }
  if (state.index === state.prompts.length - 1) return { state: undefined, value: state.draft };
  const next = { ...state, index: state.index + 1 };
  return { state: next, value: next.prompts[next.index] };
}

export class PromptHistoryNavigator {
  private state?: PromptHistoryState;
  private applying = false;

  keydown(event: KeyboardEvent, input: HTMLTextAreaElement, prompts: () => string[]): boolean {
    const direction = event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : undefined;
    const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const atPromptStart = input.selectionStart === 0 && input.selectionEnd === 0;
    if (!direction || !noModifiers || (!this.state && (direction !== "up" || !atPromptStart))) return false;
    const navigation = navigatePromptHistory(this.state, direction, input.value, this.state?.prompts ?? prompts());
    if (!navigation) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.state = navigation.state;
    this.applying = true;
    setTextInputValue(input, navigation.value);
    this.applying = false;
    return true;
  }

  inputChanged(): void {
    if (!this.applying) this.state = undefined;
  }
}

function createAgentPaneController(Controller: StimulusControllerConstructor) {
  return class AgentPaneController extends Controller implements AgentPaneControllerInstance {
    static values = { workspaceId: String, conversationId: String };
    static targets = ["transcript", "transcriptNav", "input", "form", "sendStop"];
    declare readonly element: HTMLElement;
    declare readonly application: StimulusApplication;
    declare readonly workspaceIdValue: string;
    declare readonly conversationIdValue: string;
    declare readonly transcriptTarget: HTMLElement;
    declare readonly transcriptNavTarget: HTMLButtonElement;
    declare readonly inputTarget: HTMLTextAreaElement;
    declare readonly formTarget: HTMLFormElement;
    declare readonly sendStopTarget: HTMLButtonElement;

    private stuck = true;
    private logicallyVisible = false;
    private subscribed = false;
    private hasBeenReady = false;
    private selectionAwaitingReady = false;
    private transcriptNavigationSuspendsFollowing = false;
    private transcriptMutationObserver?: MutationObserver;
    private transcriptLayoutObserver?: ResizeObserver;
    private composerMutationObserver?: MutationObserver;
    private reconnectingStatus?: HTMLElement;
    private reconnectingStatusTimer?: ReturnType<typeof setTimeout>;
    private transcriptLayoutFrame = 0;
    private transcriptEnd = 0;
    private selectionPosition?: { busy: boolean };
    private connected = false;
    private composerRevision = 0;
    private submittedComposer?: { revision: number; attachmentIds: string[] };
    private readonly promptHistory = new PromptHistoryNavigator();
    private readonly onScroll = (): void => {
      const el = this.transcriptTarget;
      const nextEnd = scrollEnd(el);
      this.stuck = this.transcriptNavigationSuspendsFollowing
        ? false
        : transcriptFollowingAfterScroll(this.stuck, this.transcriptEnd, el.scrollTop, nextEnd);
      this.transcriptEnd = nextEnd;
      this.updateTranscriptNavigation();
    };
    private readonly clearTranscriptFollowingSuspension = (): void => {
      this.transcriptNavigationSuspendsFollowing = false;
    };
    private latestUserTranscriptItem(): HTMLElement | null {
      const matches = this.transcriptTarget.querySelectorAll<HTMLElement>(".agent-user");
      return matches.item(matches.length - 1)?.closest<HTMLElement>(".agent-item") ?? null;
    }
    private updateTranscriptNavigation(): void {
      const latest = this.latestUserTranscriptItem();
      const direction = latest ? messageNavigationDirection(this.transcriptTarget, latest) : undefined;
      if (direction) this.transcriptNavTarget.dataset.direction = direction;
      else delete this.transcriptNavTarget.dataset.direction;
      this.transcriptNavTarget.disabled = !direction;
      this.transcriptNavTarget.setAttribute("aria-hidden", String(!direction));
    }
    private updateTranscriptPosition(): void {
      if (!this.logicallyVisible) return;
      if (this.selectionPosition) {
        this.transcriptTarget.scrollTop = workspaceSelectionScrollTop(this.transcriptTarget, this.latestUserTranscriptItem(), this.selectionPosition.busy);
        this.selectionPosition = undefined;
      } else if (this.stuck) {
        this.transcriptTarget.scrollTop = this.transcriptTarget.scrollHeight;
      }
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
      this.reconcileConnection();
    };
    private readonly positionForSelection = (): void => {
      const busy = this.sendStopTarget.dataset.agentBusy === "true";
      this.stuck = busy;
      this.clearTranscriptFollowingSuspension();
      this.selectionPosition = { busy };
      this.transcriptLayoutChanged();
    };
    private readonly cableReady = (): void => {
      const positionForSelection = shouldPositionTranscriptAfterSnapshot(this.hasBeenReady, this.selectionAwaitingReady);
      this.hasBeenReady = true;
      this.selectionAwaitingReady = false;
      this.setReconnecting(false);
      this.startAgentTerminals();
      if (positionForSelection) this.positionForSelection();
      else this.transcriptLayoutChanged();
    };
    private readonly cableDisconnected = (): void => {
      if (this.subscribed) this.setReconnecting(true);
    };
    private relinquishSoftwareKeyboardFocus(): void {
      if (focusLikelyOpensSoftwareKeyboard() && document.activeElement === this.inputTarget) this.inputTarget.blur();
    }
    private readonly submitting = (): void => {
      const submittedText = this.inputTarget.value;
      const submittedRevision = this.composerRevision;
      this.submittedComposer = {
        revision: submittedRevision,
        attachmentIds: new FormData(this.formTarget).getAll("attachment").map(String),
      };
      if (/^\/compact(?:\s|$)/.test(submittedText.trim())) {
        queueMicrotask(() => {
          if (this.composerRevision === submittedRevision) this.setInputValue("");
        });
      }
      this.stuck = true;
      this.clearTranscriptFollowingSuspension();
      this.transcriptLayoutChanged();
      this.relinquishSoftwareKeyboardFocus();
    };
    connect(): void {
      this.transcriptLayoutObserver = new ResizeObserver(this.transcriptLayoutChanged);
      this.transcriptLayoutObserver.observe(this.transcriptTarget);
      this.observeTranscriptItems();
      this.transcriptMutationObserver = new MutationObserver(() => {
        this.observeTranscriptItems();
      });
      this.transcriptMutationObserver.observe(this.transcriptTarget, { childList: true, subtree: true });
      this.transcriptLayoutObserver.observe(this.element.querySelector<HTMLElement>(".composer")!);
      this.transcriptEnd = scrollEnd(this.transcriptTarget);
      this.transcriptTarget.addEventListener("scroll", this.onScroll);
      this.transcriptTarget.addEventListener("wheel", this.clearTranscriptFollowingSuspension, { capture: true, passive: true });
      this.transcriptTarget.addEventListener("touchstart", this.clearTranscriptFollowingSuspension);
      this.transcriptTarget.addEventListener("pointerdown", this.clearTranscriptFollowingSuspension);
      this.transcriptTarget.addEventListener("keydown", this.clearTranscriptFollowingSuspension);
      this.updateTranscriptNavigation();
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      this.formTarget.addEventListener("submit", this.submitting);
      this.composerMutationObserver = new MutationObserver(() => this.updateSendStopButton());
      this.composerMutationObserver.observe(this.formTarget, { childList: true, subtree: true });
      const promptDraft = localStorage.getItem(this.composerTextStorageKey);
      if (promptDraft !== null) this.inputTarget.value = promptDraft;
      this.updateSendStopButton();
      this.connected = true;
    }

    disconnect(): void {
      this.connected = false;
      this.transcriptMutationObserver?.disconnect();
      this.transcriptLayoutObserver?.disconnect();
      this.composerMutationObserver?.disconnect();
      cancelAnimationFrame(this.transcriptLayoutFrame);
      this.transcriptTarget.removeEventListener("scroll", this.onScroll);
      this.transcriptTarget.removeEventListener("wheel", this.clearTranscriptFollowingSuspension, { capture: true });
      this.transcriptTarget.removeEventListener("touchstart", this.clearTranscriptFollowingSuspension);
      this.transcriptTarget.removeEventListener("pointerdown", this.clearTranscriptFollowingSuspension);
      this.transcriptTarget.removeEventListener("keydown", this.clearTranscriptFollowingSuspension);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.formTarget.removeEventListener("submit", this.submitting);
      this.logicallyVisible = false;
      this.stopConnection();
    }

    inputTargetConnected(input: HTMLTextAreaElement): void {
      if (this.connected) {
        this.composerRevision += 1;
        this.promptHistory.inputChanged();
        localStorage.setItem(this.composerTextStorageKey, input.value);
      }
      requestAnimationFrame(() => {
        if (input.isConnected && this.inputTarget === input) this.autosize();
      });
    }

    becomeVisible(): void {
      this.logicallyVisible = true;
      this.selectionAwaitingReady = true;
      this.reconcileConnection();
      this.positionForSelection();
    }

    noLongerVisible(): void {
      this.logicallyVisible = false;
      this.reconcileConnection();
    }

    terminalConnected(terminal: AgentTermControllerInstance): void {
      if (this.connectionShouldRun()) terminal.start();
    }

    private connectionShouldRun(): boolean {
      return agentConnectionShouldRun(this.logicallyVisible, document.visibilityState);
    }

    private reconcileConnection(): void {
      requestAnimationFrame(() => {
        this.autosize();
        this.updateTranscriptPosition();
      });
      if (!this.connectionShouldRun()) {
        this.stopConnection();
        return;
      }
      this.startAgentTerminals();
      if (!this.subscribed) this.subscribe();
    }

    private subscribe(): void {
      if (this.hasBeenReady) this.setReconnecting(true);
      const options: CableSubscriptionOptions = { onReady: this.cableReady, onDisconnected: this.cableDisconnected };
      window.AtelierCable?.subscribe(this.cableIdentifier(), options);
      this.subscribed = true;
    }

    private stopConnection(): void {
      this.setReconnecting(false);
      if (this.subscribed) {
        window.AtelierCable?.unsubscribe(this.cableIdentifier());
        this.subscribed = false;
      }
      this.stopAgentTerminals();
    }

    private setReconnecting(reconnecting: boolean): void {
      this.element.classList.toggle("agent-pane-reconnecting", reconnecting);
      this.transcriptTarget.setAttribute("aria-busy", String(reconnecting));
      if (!reconnecting) {
        clearTimeout(this.reconnectingStatusTimer);
        this.reconnectingStatusTimer = undefined;
        this.reconnectingStatus?.remove();
        this.reconnectingStatus = undefined;
        return;
      }
      if (this.reconnectingStatus || this.reconnectingStatusTimer) return;
      this.reconnectingStatusTimer = setTimeout(() => {
        this.reconnectingStatusTimer = undefined;
        const status = document.createElement("div");
        status.className = "agent-reconnecting-status";
        status.role = "status";
        status.textContent = "Reconnecting…";
        this.element.append(status);
        this.reconnectingStatus = status;
      }, 500);
    }

    private startAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        agentTermController(this.application, terminal)?.start();
      });
    }

    private cableIdentifier(): CableIdentifier {
      return CableTopics.agent(this.workspaceIdValue, this.conversationIdValue);
    }

    private stopAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        agentTermController(this.application, terminal)?.stop();
      });
    }

    // ---- transcript navigation ----

    jumpToLatestMessage(): void {
      const latest = this.latestUserTranscriptItem();
      if (!latest) return;
      this.stuck = false;
      this.transcriptNavigationSuspendsFollowing = true;
      scrollMessageToTop(this.transcriptTarget, latest);
    }

    // ---- AgentPaneComposer ----

    private userPrompts(): string[] {
      return [...this.transcriptTarget.querySelectorAll<HTMLElement>(".agent-user[data-agent-user-text]")].map((message) => message.dataset.agentUserText!);
    }

    inputKeydown(event: KeyboardEvent): void {
      const completionMenuOpen = Boolean(this.element.querySelector(".agent-completion-menu-host:not([hidden])"));
      if (!completionMenuOpen && this.promptHistory.keydown(event, this.inputTarget, () => this.userPrompts())) return;

      // Enter inserts a newline when typing with a hardware keyboard. A software
      // keyboard's Send key and ⌘/Ctrl+Enter both submit.
      const submitKey = composerSubmitKey(event);
      const softwareKeyboardSubmit = !completionMenuOpen && submitKey === "software-keyboard";
      if (submitKey === "shortcut" || softwareKeyboardSubmit) {
        event.preventDefault();
        if (this.inputTarget.value.trim() || this.formTarget.querySelector(".agent-chip")) {
          // Relinquish focus before requestSubmit so Turbo records the keyboard-closed state.
          if (softwareKeyboardSubmit) this.relinquishSoftwareKeyboardFocus();
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
      this.composerRevision += 1;
      this.promptHistory.inputChanged();
      localStorage.setItem(this.composerTextStorageKey, this.inputTarget.value);
      this.autosize();
    }

    private get composerTextStorageKey(): string {
      return agentComposerTextStorageKey(this.workspaceIdValue, this.conversationIdValue);
    }

    autosize(): void {
      const input = this.inputTarget;
      const maxHeight = Number.parseFloat(getComputedStyle(input).getPropertyValue("--composer-input-max-height")) || 260;
      input.style.height = "auto";
      // Add a small buffer for fractional line-height/browser rounding so a
      // one-pixel overflow doesn't flash a scrollbar before the real limit.
      const nextHeight = Math.ceil(input.scrollHeight) + 2;
      input.style.height = `${Math.min(nextHeight, maxHeight)}px`;
      input.style.overflowY = nextHeight > maxHeight ? "auto" : "hidden";
      this.updateSendStopButton();
    }

    sendStopTargetConnected(): void {
      this.updateSendStopButton();
    }

    updateSendStopButton(): void {
      const button = this.sendStopTarget;
      const busy = button.dataset.agentBusy === "true";
      const action = agentComposerPrimaryAction(busy, this.inputTarget.value, this.formTarget.querySelectorAll('input[name="attachment"]').length);
      if (action === "abort") {
        setActivityButtonState(button, "active");
        button.type = "submit";
        button.removeAttribute("name");
        button.removeAttribute("value");
        button.setAttribute("form", button.dataset.agentAbortFormId ?? "");
        return;
      }
      setActivityButtonState(button, "initial");
      button.type = "submit";
      button.name = "mode";
      button.value = action;
      button.removeAttribute("form");
    }

    submitted(event: TurboSubmitEndEvent): void {
      const submission = this.submittedComposer;
      this.submittedComposer = undefined;
      if (!event.detail.success) return;
      if (submission && this.composerRevision === submission.revision) {
        this.setInputValue("");
        localStorage.removeItem(this.composerTextStorageKey);
      }
      if (event.detail.fetchResponse?.response.headers.get("x-atelier-attachment-draft-consumed") === "true") {
        const consumed = new Set(submission?.attachmentIds ?? []);
        this.formTarget.querySelectorAll<HTMLInputElement>('input[name="attachment"]').forEach((input) => {
          if (consumed.has(input.value)) input.closest(".agent-chip")!.remove();
        });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// composer-selection-autosubmit: submit the form owned by a Composer selection
// ---------------------------------------------------------------------------

function createComposerSelectionAutosubmitController(Controller: StimulusControllerConstructor) {
  return class ComposerSelectionAutosubmitController extends Controller {
    static values = { formId: String };
    declare readonly formIdValue: string;

    submit(): void {
      document.querySelector<HTMLFormElement>(`#${CSS.escape(this.formIdValue)}`)!.requestSubmit();
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
// agent-code-copy: copy markdown code blocks to clipboard
// ---------------------------------------------------------------------------

function createAgentCodeCopyController(Controller: StimulusControllerConstructor) {
  return class AgentCodeCopyController extends Controller {
    static targets = ["button", "code"];
    declare readonly buttonTarget: HTMLButtonElement;
    declare readonly codeTarget: HTMLElement;
    private timer?: ReturnType<typeof setTimeout>;

    disconnect(): void {
      if (this.timer) clearTimeout(this.timer);
    }

    async copy(): Promise<void> {
      const button = this.buttonTarget;
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

const htmlPreviewBaselineHeight = 420;
const htmlPreviewResourceGraceMs = 2_000;
const htmlPreviewResourceDebounceMs = 100;

type HtmlPreviewFrame = { style: { height: string } };
type HtmlPreviewDocument = { body: Pick<HTMLElement, "scrollHeight">; documentElement: Pick<HTMLElement, "scrollHeight"> };

export function fitHtmlPreview(frame: HtmlPreviewFrame, doc: HtmlPreviewDocument): void {
  frame.style.height = `${htmlPreviewBaselineHeight}px`;
  frame.style.height = `${Math.max(htmlPreviewBaselineHeight, doc.documentElement.scrollHeight, doc.body.scrollHeight)}px`;
}

function createAgentHtmlPreviewController(Controller: StimulusControllerConstructor) {
  return class AgentHtmlPreviewController extends Controller {
    declare readonly element: HTMLIFrameElement;
    private document?: Document;
    private resourceGraceTimer?: ReturnType<typeof setTimeout>;
    private resourceFitTimer?: ReturnType<typeof setTimeout>;
    private readonly loaded = (): void => this.attach();
    private readonly resourceLoaded = (event: Event): void => {
      const view = this.document?.defaultView;
      if (!view || !(event.target instanceof view.HTMLImageElement)) return;
      clearTimeout(this.resourceFitTimer);
      this.resourceFitTimer = setTimeout(() => this.fit(), htmlPreviewResourceDebounceMs);
    };

    connect(): void {
      this.element.addEventListener("load", this.loaded);
      if (this.element.contentDocument?.readyState === "complete") this.attach();
    }

    disconnect(): void {
      this.element.removeEventListener("load", this.loaded);
      this.detach();
    }

    private detach(): void {
      this.document?.removeEventListener("load", this.resourceLoaded, true);
      clearTimeout(this.resourceGraceTimer);
      clearTimeout(this.resourceFitTimer);
      this.document = undefined;
    }

    private fit(): void {
      if (this.document) fitHtmlPreview(this.element, this.document);
    }

    private attach(): void {
      this.detach();
      const doc = this.element.contentDocument!;
      this.document = doc;
      doc.addEventListener("load", this.resourceLoaded, true);
      this.resourceGraceTimer = setTimeout(() => doc.removeEventListener("load", this.resourceLoaded, true), htmlPreviewResourceGraceMs);
      this.fit();
      void doc.fonts.ready.then(() => {
        if (this.document === doc) this.fit();
      });
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
        const fullscreen = active && autocomplete.fullscreenShortcut?.(active);
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
      if (option && this.options().includes(option)) this.activate(option, false);
    };

    private optionFromEvent(event: Event): HTMLElement | null {
      return event.target instanceof Element ? event.target.closest<HTMLElement>(autocomplete.optionSelector) : null;
    }

    private readonly menuEvent = (event: Event): void => {
      autocomplete.menuEvent?.(event, this.inputTarget);
    };

    private readonly blur = (event: Event): void => {
      if (!(event instanceof FocusEvent)) throw new Error("Autocomplete blur handler received a non-focus event");
      if (autocomplete.keepOpenOnBlur?.(this.inputTarget, this.menuTarget)) return;
      const relatedTarget = event.relatedTarget;
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
      if (!html.trim()) {
        this.close();
        return;
      }
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
      return [...this.menuTarget.querySelectorAll<HTMLElement>(autocomplete.optionSelector)].filter((option) => option.getAttribute("role") === "option");
    }

    private activeOption(): HTMLElement | undefined {
      return this.options().find((option) => option.classList.contains("active")) ?? this.options()[0];
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
      if (autocomplete.select(option, this.inputTarget, this.urlValue) === false) return;
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
  kind: "quick-launch" | "slash-command" | "file";
  query: string;
  mode?: "direct" | "fuzzy";
}

export function agentCompletionRequest(input: AgentCompletionInput, force = false): AgentCompletionRequest | undefined {
  if (force) {
    const prefix = fileCompletionPrefix(input);
    return { kind: "file", query: rawFileCompletionQuery(prefix), mode: prefix.startsWith("@") ? "fuzzy" : "direct" };
  }

  if (input.value === "") return { kind: "quick-launch", query: "" };

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

const treeComingSoonMessage = "/tree feature is coming soon!";

function showApplicationCommandNotice(input: AgentCompletionInput & HTMLElement, message: string): void {
  const notices = input.closest(".agent-pane")!.querySelector<HTMLElement>(".agent-notices")!;
  const notice = document.createElement("div");
  notice.className = "agent-noticeline info";
  notice.dataset.controller = "agent-notice";
  notice.setAttribute("role", "status");
  notice.textContent = message;
  notices.append(notice);
}

function runApplicationCommand(option: HTMLElement, input: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (option.dataset.commandAction !== "notice") return false;
  input.value = "";
  showApplicationCommandNotice(input, option.dataset.commandMessage!);
  return true;
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

function promptTemplateTriggerForHotkey(html: string, hotkey: string): string | undefined {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  return container.content.querySelector<HTMLElement>(`[data-prompt-template-hotkey="${hotkey}"]`)?.dataset.commandTrigger;
}

type ShortcutCommand = Pick<WorkspaceClientCommand, "label" | "binding">;

export function promptTemplateHotkeyConflict(hotkey: string, commands: readonly ShortcutCommand[]): ShortcutCommand | undefined {
  const binding = `Meta+Alt+Key${hotkey.toUpperCase()}`;
  return commands.find((command) => command.binding === binding);
}

function visibleWorkspaceCommands(): ShortcutCommand[] {
  const presentation = document.querySelector<HTMLElement>(".workspace-detail-resident.visible .fixed-workspace-presentation")
    ?? document.querySelector<HTMLElement>(".fixed-workspace-presentation");
  if (!presentation) return [];
  // SAFETY: The server serializes WorkspaceCommandRegistration values into this dataset.
  return JSON.parse(presentation.dataset.workspaceCommands!) as ShortcutCommand[];
}

function promptTemplateShortcutConflict(hooks: WorkspaceClientHooks, hotkey: string): ShortcutCommand | undefined {
  return promptTemplateHotkeyConflict(hotkey, [...hooks.registeredCommands(), ...visibleWorkspaceCommands()]);
}

function markPromptTemplateShortcutConflicts(html: string, hooks: WorkspaceClientHooks): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  for (const option of container.content.querySelectorAll<HTMLElement>("[data-prompt-template-hotkey]")) {
    const hotkey = option.dataset.promptTemplateHotkey!;
    const conflict = promptTemplateShortcutConflict(hooks, hotkey);
    if (!conflict) continue;
    option.removeAttribute("data-prompt-template-hotkey");
    option.removeAttribute("aria-keyshortcuts");
    const message = `Shortcut unavailable: ⌘⌥${hotkey.toUpperCase()} is used by ${conflict.label}.`;
    option.title = message;
    option.setAttribute("aria-label", `${option.getAttribute("aria-label") ?? option.dataset.commandTrigger}. ${message}`);
    const shortcut = option.querySelector<HTMLElement>(".agent-quick-launch-shortcut");
    if (shortcut) {
      shortcut.classList.add("conflict");
      shortcut.textContent = `⌘⌥${hotkey.toUpperCase()} used by ${conflict.label}`;
    }
  }
  return container.innerHTML;
}

function filterSlashCompletionCatalog(html: string, query: string, compactAvailable: boolean): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  const menu = container.content.querySelector<HTMLElement>(".autocomplete-menu")!;
  const compact = menu.querySelector<HTMLButtonElement>('[data-command-trigger="/compact"]');
  if (compact && !compactAvailable) {
    compact.disabled = true;
    compact.setAttribute("aria-disabled", "true");
    compact.querySelector<HTMLElement>(".action-item__label-text")!.textContent = "/compact [instructions] — Available after more conversation history.";
  }
  const normalized = query.toLowerCase();
  const options = [...menu.querySelectorAll<HTMLButtonElement>(".agent-completion-option")]
    .filter((option) => option.dataset.commandTrigger!.slice(1).toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.dataset.commandTrigger!.slice(1).toLowerCase();
      const bName = b.dataset.commandTrigger!.slice(1).toLowerCase();
      return Number(bName.startsWith(normalized)) - Number(aName.startsWith(normalized)) || aName.localeCompare(bName);
    })
    .slice(0, 12);

  if (options.length === 0) return `<div class="popup-menu autocomplete-menu autocomplete-empty">No matching commands</div>`;
  menu.replaceChildren(...options);
  const active = options.find((option) => !option.disabled);
  for (const option of options) {
    option.classList.toggle("active", option === active);
    option.setAttribute("aria-selected", option === active ? "true" : "false");
  }
  return menu.outerHTML;
}

async function commandCatalogHtml(url: URL, interaction: HtmlAutocompleteInteraction): Promise<string> {
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
  return catalog;
}

async function slashCompletionHtml(url: URL, interaction: HtmlAutocompleteInteraction, query: string, compactAvailable: boolean): Promise<string> {
  return filterSlashCompletionCatalog(await commandCatalogHtml(url, interaction), query, compactAvailable);
}

async function quickLaunchHtml(url: URL, interaction: HtmlAutocompleteInteraction): Promise<string> {
  const container = document.createElement("template");
  container.innerHTML = (await commandCatalogHtml(url, interaction)).trim();
  return container.content.querySelector<HTMLElement>(".agent-quick-launches")?.outerHTML ?? "";
}

async function expandedPromptTemplate(url: string, text: string): Promise<string> {
  const body = new FormData();
  body.set("text", text);
  const response = await fetch(`${url}/prompt-template-expand`, { method: "POST", body, headers: { Accept: "text/plain" } });
  return await response.text();
}

function composerIsTranscribing(element: Element): boolean {
  return Boolean(element.closest(".composer")?.hasAttribute("data-transcribing"));
}

function createAgentCompletionsController(Controller: StimulusControllerConstructor, hooks: WorkspaceClientHooks) {
  const HtmlAutocompleteController = createHtmlAutocompleteController(Controller, {
    optionSelector: ".agent-completion-option:not([hidden]):not(:disabled)",
    loadingHtml: `<div class="popup-menu autocomplete-menu autocomplete-empty" role="status"><span class="agent-completion-spinner" aria-hidden="true"></span>Loading completions…</div>`,
    triggerKeysWhenClosed: ["/", "@"],
    fullscreenShortcut: (option) => option.dataset.completionKind === "prompt-template",
    keepOpenOnBlur: (input, menu) => !composerIsTranscribing(input) && input.value === "" && Boolean(menu.querySelector(".agent-quick-launch")),
    menuEvent: handleAgentTreeMenuEvent,
    request(input, force) {
      if (composerIsTranscribing(input)) return undefined;
      const completion = agentCompletionRequest(input, force);
      if (!completion) return completion;
      interface CompletionRequestParams {
        [name: string]: string;
        kind: typeof completion.kind;
      }
      const params: CompletionRequestParams = { kind: completion.kind };
      if (completion.mode) params["mode"] = completion.mode;
      if (completion.kind === "slash-command") {
        const availability = input.closest(".agent-pane")?.querySelector<HTMLElement>("[data-agent-compact-available]");
        params["compactAvailable"] = String(availability?.dataset.agentCompactAvailable !== "false");
      }
      return { query: completion.query, params, debounceMs: completion.kind === "file" ? 70 : 0 };
    },
    loadHtml(request, url, interaction) {
      const html = request.params?.kind === "quick-launch"
        ? quickLaunchHtml(url, interaction)
        : request.params?.kind === "slash-command"
          ? slashCompletionHtml(url, interaction, request.query, request.params.compactAvailable !== "false")
          : undefined;
      return html?.then((content) => markPromptTemplateShortcutConflicts(content, hooks));
    },
    select(option, input, url) {
      if (runApplicationCommand(option, input)) return;
      if (selectAgentTreeOption(option, input)) return false;
      if (option.dataset.completionKind === "quick-launch") {
        const initialValue = input.value;
        void expandedPromptTemplate(url, option.dataset.commandTrigger!).then((expanded) => {
          if (input.value !== initialValue || composerIsTranscribing(input)) return;
          setTextInputValue(input, expanded);
          if (!focusLikelyOpensSoftwareKeyboard()) input.focus({ preventScroll: true });
        });
      } else if (option.dataset.commandTrigger) insertSlashCommand(option, input);
      else if (option.dataset.completionKind === "file") insertFileCompletion(option, input);
    },
    keydown(event, input, url, actions) {
      const send = composerSubmitKey(event) === "shortcut";
      const expand = event.key === "Enter" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key === "Enter" && input.value.trim() === "/tree") {
        event.preventDefault();
        event.stopImmediatePropagation();
        actions.setInputValue("");
        actions.close();
        showApplicationCommandNotice(input, treeComingSoonMessage);
        return true;
      }
      if (handleAgentTreeKeydown(event, input, actions)) return true;
      if (send || expand) {
        const active = actions.open ? actions.activeOption() : undefined;
        if (active?.dataset.commandTrigger) actions.select(active);
        if (send || !/^\/[^/\s]+(?:\s+[\s\S]*)?$/.test(input.value.trim())) return false;
        event.preventDefault();
        void expandedPromptTemplate(url, input.value)
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
      window.addEventListener("keydown", this.promptTemplateHotkey);
      void refreshSlashCatalog(this.urlValue).then(() => this.input());
    }

    disconnect(): void {
      window.removeEventListener("keydown", this.promptTemplateHotkey);
      super.disconnect();
    }

    private readonly promptTemplateHotkey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey) return;
      const match = event.code.match(/^Key([A-Z])$/);
      if (!match || this.element.getClientRects().length === 0 || composerIsTranscribing(this.element)) return;
      const resident = this.element.closest<HTMLElement>(".workspace-detail-resident");
      if (resident && !resident.classList.contains("visible")) return;
      const catalog = slashCatalogCache.get(slashCatalogUrl(this.urlValue).href)?.html;
      if (!catalog) return;
      const hotkey = match[1]!.toLowerCase();
      if (promptTemplateShortcutConflict(hooks, hotkey)) return;
      const trigger = promptTemplateTriggerForHotkey(catalog, hotkey);
      if (!trigger) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      const initialValue = this.inputTarget.value;
      void expandedPromptTemplate(this.urlValue, trigger).then((expanded) => {
        if (this.inputTarget.value !== initialValue || composerIsTranscribing(this.element)) return;
        setTextInputValue(this.inputTarget, expanded);
        const form = this.inputTarget.form!;
        const submitter = form.querySelector<HTMLButtonElement>('button[value="send"], button[value="steer"]');
        form.requestSubmit(submitter ?? undefined);
      });
    };
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
      transcript?: { element: HTMLElement; top: number };
    };
    private scrollers(): HTMLElement[] {
      return [...this.element.querySelectorAll<HTMLElement>(".agent-tail-output")];
    }
    prepare(event: Event): void {
      if (!(event.currentTarget instanceof HTMLAnchorElement)) throw new Error("Agent tail pagination action requires a link");
      const scrollers = this.scrollers();
      const scroller = event.currentTarget.closest<HTMLElement>(".agent-tail-output");
      if (!scroller) throw new Error("Agent tail pagination link requires an output container");
      const transcript = this.element.closest<HTMLElement>(".agent-transcript");
      this.previous = {
        scrollerIndex: scrollers.indexOf(scroller),
        height: scroller.scrollHeight,
        top: scroller.scrollTop,
        tail: scroller.dataset.agentTailDirection === "last",
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
      if (this.frameTarget.getAttribute("src")) return;
      this.frameTarget.setAttribute("src", this.frameTarget.dataset.src!);
    }
  };
}

// ---------------------------------------------------------------------------
// agent-term: inline read-only terminal attached to an agent tmux session
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

export function terminalOutputHasPrintableText(text: string): boolean {
  const withoutEscapeSequences = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g, "");
  return Boolean(withoutEscapeSequences.replace(/[\x00-\x1f\x7f]/g, "").trim());
}

function createAgentTermController(Controller: StimulusControllerConstructor) {
  return class AgentTermController extends Controller implements AgentTermControllerInstance {
    static values = { workspaceId: String, session: String };
    declare readonly element: HTMLElement;
    declare readonly application: StimulusApplication;
    declare readonly workspaceIdValue: string;
    declare readonly sessionValue: string;
    private viewer?: ObservableTerminalViewer;
    private running = false;
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
      document.addEventListener("atelier:theme-change", this.themeChanged);
      this.element.addEventListener("wheel", this.wheel, { capture: true, passive: false });
      agentPaneController(this.application, this.element)?.terminalConnected(this);
    }

    start(): void {
      this.running = true;
      if (this.viewer || this.starting) return;
      this.starting = true;
      const style = getComputedStyle(this.element);
      const region = this.element.closest<HTMLElement>(".agent-bash-output")!;
      void createObservableTerminalViewer({
        host: this.element,
        mode: "fixed-readonly",
        cols: 120,
        rows: 30,
        websocketUrl: observableWebSocketUrl(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agent-term/${encodeURIComponent(this.sessionValue)}/ws?cols=120&rows=30`),
        fontFamily: style.getPropertyValue("--font-mono"),
        fontSize: Number.parseFloat(style.getPropertyValue("--text-code")),
        theme: this.theme(),
        onOutput: (text) => {
          if (region.classList.contains("agent-terminal-awaiting-output") && terminalOutputHasPrintableText(text)) {
            region.classList.remove("agent-terminal-awaiting-output");
          }
        },
      })
        .then((viewer) => {
          if (!this.running) viewer.dispose();
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

    stop(): void {
      this.running = false;
      this.viewer?.dispose();
      this.viewer = undefined;
    }

    disconnect(): void {
      this.stop();
      document.removeEventListener("atelier:theme-change", this.themeChanged);
      this.element.removeEventListener("wheel", this.wheel, { capture: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Agent conversation visibility hook
// ---------------------------------------------------------------------------

function agentPaneController(application: StimulusApplication, pane: HTMLElement): AgentPaneControllerInstance | null {
  const agentPane = pane.matches('[data-controller~="agent-pane"]')
    ? pane
    : pane.closest<HTMLElement>('[data-controller~="agent-pane"]') ?? pane.querySelector<HTMLElement>('[data-controller~="agent-pane"]');
  // SAFETY: This module registers AgentPaneController under "agent-pane"; Stimulus
  // returns that registered controller for this exact element-and-identifier pair.
  return agentPane ? application.getControllerForElementAndIdentifier(agentPane, "agent-pane") as AgentPaneControllerInstance | null : null;
}

function agentConversationBecameVisible(application: StimulusApplication, pane: HTMLElement): void {
  agentPaneController(application, pane)?.becomeVisible();
}

function agentConversationNoLongerVisible(application: StimulusApplication, pane: HTMLElement): void {
  agentPaneController(application, pane)?.noLongerVisible();
}

function createAgentEditDiffController(Controller: StimulusControllerConstructor) {
  return class AgentEditDiffController extends Controller {
    static targets = ["model"];
    declare readonly modelTarget: HTMLScriptElement;
    private instances: Array<{ cleanUp(): void }> = [];

    connect(): void { void this.render(); }

    disconnect(): void {
      for (const instance of this.instances) instance.cleanUp();
      this.instances = [];
    }

    private async render(): Promise<void> {
      const [{ FileDiff }, { toolDiffOptions }] = await Promise.all([import("@pierre/diffs"), import("@atelier/syntax/pierre")]);
      if (!this.element.isConnected) return;
      // SAFETY: This private script is serialized by editDiffHtml from FileDiffMetadata[].
      const diffs = JSON.parse(this.modelTarget.textContent ?? "[]") as Array<import("@pierre/diffs").FileDiffMetadata>;
      const containers = [...this.element.querySelectorAll<HTMLElement>("diffs-container")];
      for (const [index, fileDiff] of diffs.entries()) {
        const instance = new FileDiff(toolDiffOptions);
        instance.render({ fileContainer: containers[index]!, fileDiff });
        this.instances.push(instance);
      }
    }
  };
}

export const agentClientModule: WorkspaceClientModule = {
  id: "agent",
  install({ application, Controller, hooks }) {
    application.register("agent-pane", createAgentPaneController(Controller));
    application.register("agent-attachments", createAgentAttachmentsController(Controller));
    application.register("composer-selection-autosubmit", createComposerSelectionAutosubmitController(Controller));
    application.register("agent-code-copy", createAgentCodeCopyController(Controller));
    application.register("agent-elapsed", createAgentElapsedController(Controller));
    application.register("agent-edit-diff", createAgentEditDiffController(Controller));
    application.register("agent-html-preview", createAgentHtmlPreviewController(Controller));
    application.register("agent-thinking", createAgentThinkingController(Controller));
    application.register("agent-tail-frame", createAgentTailFrameController(Controller));
    application.register("agent-lazy-detail", createAgentLazyDetailController(Controller));
    application.register("agent-notice", createAgentNoticeController(Controller));
    application.register("agent-completions", createAgentCompletionsController(Controller, hooks));
    application.register("agent-proxy", createAgentProxyController(Controller));
    application.register("agent-term", createAgentTermController(Controller));

    hooks.onBecomeVisible(({ pane }) => agentConversationBecameVisible(application, pane));
    hooks.onNoLongerVisible(({ pane }) => agentConversationNoLongerVisible(application, pane));
    const openLaunchComposer = (): void => {
      const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.visible");
      const projectId = resident ? resident.dataset.projectId : localStorage.getItem(recentWorkspaceProjectStorageKey);
      const frame = document.getElementById("launch_composer")!;
      frame.replaceChildren();
      frame.removeAttribute("src");
      frame.setAttribute("src", projectId ? `/projects/${encodeURIComponent(projectId)}/launch-composer` : "/launch-composer");
    };
    hooks.registerCommand({
      id: "agent.open-launch-composer",
      label: "New Workspace With Same Project",
      description: "Open a LaunchComposer using the most recently selected Workspace's Project.",
      scope: "global",
      binding: "Meta+Alt+Quote",
      run: openLaunchComposer,
    });
  },
};
