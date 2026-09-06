import { setActivityButtonState } from "@atelier/design-system/activity-button/client";
import { CableTopics, composerSubmitKey, focusLikelyOpensSoftwareKeyboard, setTextInputValue, type CableSubscription, type WorkspaceClientApplication as StimulusApplication, type WorkspaceClientControllerConstructor as StimulusControllerConstructor, type WorkspaceClientHooks } from "@atelier/shared";
import { agentComposerPrimaryAction, agentComposerTextStorageKey, PromptHistoryNavigator } from "./composer-state.ts";
import { transcriptFollowingAfterScroll, transcriptScrollPosition, workspaceSelectionScrollTop } from "./transcript-navigation.ts";

type TurboSubmitEndEvent = CustomEvent<{ success: boolean; fetchResponse?: { response: Response } }>;

declare global {
  interface Window { AtelierCable?: import("@atelier/shared").AtelierCableClient; }
}

interface AgentPaneControllerInstance {
  becomeVisible(): void;
  noLongerVisible(): void;
  terminalConnected(terminal: AgentTermControllerInstance): void;
}

interface AgentTermControllerInstance { start(): void; stop(): void; }

function agentTermController(application: StimulusApplication, terminal: HTMLElement): AgentTermControllerInstance | null {
  // SAFETY: AgentTermController is registered under "agent-term" by agentClientModule.
  return application.getControllerForElementAndIdentifier(terminal, "agent-term") as AgentTermControllerInstance | null;
}

export function agentConnectionShouldRun(logicallyVisible: boolean, documentVisibility: DocumentVisibilityState): boolean {
  return logicallyVisible && documentVisibility === "visible";
}

export function createAgentPaneController(Controller: StimulusControllerConstructor) {
  return class AgentPaneController extends Controller implements AgentPaneControllerInstance {
    static values = { workspaceId: String, conversationId: String };
    static targets = ["transcript", "transcriptEnd", "input", "form", "sendStop"];
    declare readonly element: HTMLElement;
    declare readonly application: StimulusApplication;
    declare readonly workspaceIdValue: string;
    declare readonly conversationIdValue: string;
    declare readonly transcriptTarget: HTMLElement;
    declare readonly transcriptEndTarget: HTMLElement;
    declare readonly inputTarget: HTMLTextAreaElement;
    declare readonly formTarget: HTMLFormElement;
    declare readonly sendStopTarget: HTMLButtonElement;

    private stuck = true;
    private logicallyVisible = false;
    private cableSubscription?: CableSubscription;
    private hasBeenReady = false;
    private selectionAwaitingReady = false;
    private transcriptMutationObserver?: MutationObserver;
    private transcriptLayoutObserver?: ResizeObserver;
    private composerMutationObserver?: MutationObserver;
    private reconnectingStatus?: HTMLElement;
    private reconnectingStatusTimer?: ReturnType<typeof setTimeout>;
    private scrollbarHideTimer?: ReturnType<typeof setTimeout>;
    private transcriptLayoutFrame = 0;
    private transcriptPosition = { top: 0, end: 0, height: 0 };
    private selectedWhileBusy?: boolean;
    private connected = false;
    private composerRevision = 0;
    private submittedComposer?: { revision: number; attachmentIds: string[] };
    private readonly promptHistory = new PromptHistoryNavigator();
    private readonly onScroll = (event?: Event): void => {
      const el = this.transcriptTarget;
      if (event) {
        el.classList.add("is-scrolling");
        clearTimeout(this.scrollbarHideTimer);
        this.scrollbarHideTimer = setTimeout(() => el.classList.remove("is-scrolling"), 800);
      }
      const next = transcriptScrollPosition(el);
      this.stuck = transcriptFollowingAfterScroll(this.stuck, this.transcriptPosition, next);
      this.transcriptPosition = next;
      this.transcriptEndTarget.hidden = this.stuck;
    };
    private latestUserTranscriptItem(): HTMLElement | null {
      const matches = this.transcriptTarget.querySelectorAll<HTMLElement>(".agent-user");
      return matches.item(matches.length - 1)?.closest<HTMLElement>(".agent-item") ?? null;
    }
    private updateTranscriptPosition(): void {
      if (!this.logicallyVisible) return;
      if (this.selectedWhileBusy !== undefined) {
        this.transcriptTarget.scrollTop = workspaceSelectionScrollTop(this.transcriptTarget, this.latestUserTranscriptItem(), this.selectedWhileBusy);
        this.selectedWhileBusy = undefined;
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
      this.selectedWhileBusy = busy;
      this.transcriptLayoutChanged();
    };
    private readonly cableReady = (): void => {
      const positionForSelection = this.selectionAwaitingReady;
      this.hasBeenReady = true;
      this.selectionAwaitingReady = false;
      this.setReconnecting(false);
      this.startAgentTerminals();
      if (positionForSelection) this.positionForSelection();
      else this.transcriptLayoutChanged();
    };
    private readonly cableDisconnected = (): void => {
      if (this.cableSubscription) this.setReconnecting(true);
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
      // Reach the current end before blurring. On mobile, closing the keyboard
      // can emit a layout-driven scroll event before the next animation frame;
      // if we are still scrolled up then, it looks like the user opted out of
      // following and cancels the submit-time jump.
      this.scrollToTranscriptEnd();
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
      this.transcriptPosition = transcriptScrollPosition(this.transcriptTarget);
      this.transcriptTarget.addEventListener("scroll", this.onScroll);
      this.transcriptEndTarget.hidden = this.stuck;
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      // Software-keyboard changes may precede ResizeObserver notifications.
      window.visualViewport?.addEventListener("resize", this.transcriptLayoutChanged);
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
      clearTimeout(this.scrollbarHideTimer);
      this.transcriptTarget.classList.remove("is-scrolling");
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      window.visualViewport?.removeEventListener("resize", this.transcriptLayoutChanged);
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
      requestAnimationFrame(() => this.autosize());
      if (!this.connectionShouldRun()) {
        this.stopConnection();
        return;
      }
      this.startAgentTerminals();
      if (!this.cableSubscription) this.subscribe();
    }

    private subscribe(): void {
      if (this.hasBeenReady) this.setReconnecting(true);
      this.cableSubscription = window.AtelierCable?.subscribe(
        CableTopics.agent(this.workspaceIdValue, this.conversationIdValue),
        { onReady: this.cableReady, onDisconnected: this.cableDisconnected },
      );
    }

    private stopConnection(): void {
      this.setReconnecting(false);
      this.cableSubscription?.unsubscribe();
      this.cableSubscription = undefined;
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

    private stopAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        agentTermController(this.application, terminal)?.stop();
      });
    }

    // ---- transcript navigation ----

    scrollToTranscriptEnd(): void {
      // Explicit navigation supersedes selection positioning, both the pending
      // animation frame and a snapshot that has not arrived yet.
      this.selectedWhileBusy = undefined;
      this.selectionAwaitingReady = false;
      this.stuck = true;
      this.transcriptTarget.scrollTop = this.transcriptTarget.scrollHeight;
      this.onScroll();
    }

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
      // height:auto can temporarily clamp the transcript without a net viewport
      // resize. Restore its position before the resulting scroll event arrives.
      this.updateTranscriptPosition();
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


export function findAgentPaneController(application: StimulusApplication, pane: HTMLElement): AgentPaneControllerInstance | null {
  const agentPane = pane.matches('[data-controller~="agent-pane"]')
    ? pane
    : pane.closest<HTMLElement>('[data-controller~="agent-pane"]') ?? pane.querySelector<HTMLElement>('[data-controller~="agent-pane"]');
  // SAFETY: AgentPaneController is registered under "agent-pane" by agentClientModule.
  return agentPane ? application.getControllerForElementAndIdentifier(agentPane, "agent-pane") as AgentPaneControllerInstance | null : null;
}

export function registerAgentPaneVisibilityHooks(application: StimulusApplication, hooks: WorkspaceClientHooks): void {
  hooks.onBecomeVisible(({ pane }) => findAgentPaneController(application, pane)?.becomeVisible());
  hooks.onNoLongerVisible(({ pane }) => findAgentPaneController(application, pane)?.noLongerVisible());
}
