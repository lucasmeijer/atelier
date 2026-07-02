/// <reference lib="dom" />

import { createObservableTerminalViewer, observableWebSocketUrl, type ObservableTerminalViewer } from "@atelier/observable-terminal/client";
import { CableTopics, copyTextToClipboard, workspaceProxyUrl, type AtelierCableClient, type CableIdentifier, type WorkspaceClientModule, type WorkspacePaletteItem } from "@atelier/shared";

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };

type HtmlAutocompleteOptions = {
  optionSelector: string;
  query(input: HTMLInputElement | HTMLTextAreaElement): string | undefined;
  select(option: HTMLElement, input: HTMLInputElement | HTMLTextAreaElement): void;
  keydown?(event: KeyboardEvent, input: HTMLInputElement | HTMLTextAreaElement, url: string, actions: HtmlAutocompleteActions): boolean;
  debounceMs?: number;
  loadingHtml?: string;
  triggerKeysWhenClosed?: string[];
};

type HtmlAutocompleteActions = {
  setInputValue(value: string): void;
  close(): void;
};

function notifyInputListeners(input: HTMLInputElement | HTMLTextAreaElement): void {
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  notifyInputListeners(input);
}

type StimulusApplication = {
  getControllerForElementAndIdentifier(element: Element, identifier: string): unknown;
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

// ---------------------------------------------------------------------------
// agent-pane: cable subscription lifecycle, scroll anchoring, prompt behavior, rewind dialog
// ---------------------------------------------------------------------------

function createAgentPaneController(Controller: StimulusControllerConstructor) {
  return class AgentPaneController extends Controller implements AgentPaneControllerInstance {
    static values = { workspaceId: String, label: String };
    static targets = ["transcript", "input", "form", "rewindDialog", "rewindEntry", "rewindPreview"];
    declare readonly element: HTMLElement;
    declare readonly application: StimulusApplication;
    declare readonly workspaceIdValue: string;
    declare readonly labelValue: string;
    declare readonly transcriptTarget: HTMLElement;
    declare readonly inputTarget: HTMLTextAreaElement;
    declare readonly formTarget: HTMLFormElement;
    declare readonly rewindDialogTarget: HTMLDialogElement;
    declare readonly rewindEntryTarget: HTMLInputElement;
    declare readonly rewindPreviewTarget: HTMLElement;

    private stuck = true;
    private subscribed = false;
    private observer?: MutationObserver;
    private promptObserver?: MutationObserver;
    private rewindUserText = "";
    private readonly onScroll = (): void => {
      const el = this.transcriptTarget;
      this.stuck = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    };
    private readonly onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && this.element.closest(".tab-pane")?.classList.contains("visible")) {
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
      this.promptObserver = new MutationObserver(() => this.updateSendStopButton());
      this.promptObserver.observe(this.formTarget, { childList: true, subtree: true });
      this.transcriptTarget.addEventListener("scroll", this.onScroll);
      document.addEventListener("keydown", this.onKeydown);
      this.updateSendStopButton();
      if (this.element.closest(".tab-pane")?.classList.contains("visible")) this.start();
    }

    disconnect(): void {
      this.observer?.disconnect();
      this.promptObserver?.disconnect();
      this.transcriptTarget.removeEventListener("scroll", this.onScroll);
      document.removeEventListener("keydown", this.onKeydown);
      this.stop();
    }

    start(): void {
      requestAnimationFrame(() => this.autosize());
      if (this.subscribed) return;
      window.AtelierCable?.subscribe(this.cableIdentifier());
      this.subscribed = true;
    }

    stop(): void {
      if (!this.subscribed) return;
      window.AtelierCable?.unsubscribe(this.cableIdentifier());
      this.subscribed = false;
      this.disposeAgentTerminals();
    }

    private path(suffix: string): string {
      return `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agents/${encodeURIComponent(this.labelValue)}${suffix}`;
    }

    private cableIdentifier(): CableIdentifier {
      return CableTopics.agent(this.workspaceIdValue, this.labelValue);
    }

    private disposeAgentTerminals(): void {
      this.element.querySelectorAll<HTMLElement>('[data-controller~="agent-term"]').forEach((terminal) => {
        const controller = (this.application as unknown as StimulusApplication).getControllerForElementAndIdentifier(terminal, "agent-term") as { disconnect?(): void } | null;
        controller?.disconnect?.();
        terminal.remove();
      });
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

    private setInputValue(value: string): void {
      setTextInputValue(this.inputTarget, value);
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
      const checked = tool?.querySelector<HTMLInputElement>(".agent-bash-mode-input:checked");
      const pane = checked?.classList.contains("agent-bash-mode-model")
        ? tool?.querySelector<HTMLElement>(".agent-bash-pane-model")
        : tool?.querySelector<HTMLElement>(".agent-bash-pane-terminal");
      const result = pane?.querySelector<HTMLElement>(".agent-tool-result") ?? tool?.querySelector<HTMLElement>(".agent-tool-result");
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

    connect(): void {
      this.menuTarget.addEventListener("click", this.click);
      this.menuTarget.addEventListener("pointerover", this.pointerover);
    }

    disconnect(): void {
      this.menuTarget.removeEventListener("click", this.click);
      this.menuTarget.removeEventListener("pointerover", this.pointerover);
      window.clearTimeout(this.debounceTimer);
    }

    input(): void {
      this.scheduleRefresh();
    }

    keydown(event: KeyboardEvent): void {
      if (autocomplete.keydown?.(event, this.inputTarget, this.urlValue, { setInputValue: (value) => setTextInputValue(this.inputTarget, value), close: () => this.close() })) return;
      if (this.menuTarget.hidden) {
        if (autocomplete.triggerKeysWhenClosed?.includes(event.key)) requestAnimationFrame(() => this.scheduleRefresh());
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.move(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        this.moveTo(event.key === "Home" ? 0 : this.options().length - 1);
        return;
      }
      if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const active = this.activeOption();
        if (!active) return;
        event.preventDefault();
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        const active = this.activeOption();
        if (!active) return;
        event.preventDefault();
        this.insert(active);
      }
    }

    private scheduleRefresh(): void {
      window.clearTimeout(this.debounceTimer);
      const debounceMs = autocomplete.debounceMs ?? 0;
      if (debounceMs === 0) {
        void this.refresh();
        return;
      }
      this.debounceTimer = window.setTimeout(() => void this.refresh(), debounceMs);
    }

    private readonly click = (event: Event): void => {
      const option = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(autocomplete.optionSelector) : null;
      if (!option) return;
      event.preventDefault();
      this.insert(option);
    };

    private readonly pointerover = (event: Event): void => {
      const option = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(autocomplete.optionSelector) : null;
      if (option) this.activate(option, false);
    };

    private async refresh(): Promise<void> {
      const query = autocomplete.query(this.inputTarget);
      if (query === undefined) {
        this.close();
        return;
      }
      const id = ++this.requestId;
      if (autocomplete.loadingHtml) {
        this.menuTarget.innerHTML = autocomplete.loadingHtml;
        this.menuTarget.hidden = false;
      }
      const url = new URL(this.urlValue, window.location.href);
      url.searchParams.set("q", query);
      const html = await fetch(url, { headers: { Accept: "text/html" } }).then((response) => response.text());
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
      autocomplete.select(option, this.inputTarget);
      notifyInputListeners(this.inputTarget);
      this.close();
    }
  };
}

// ---------------------------------------------------------------------------
// agent-prompt-templates: slash-command autocomplete for repository templates
// ---------------------------------------------------------------------------

function createAgentPromptTemplatesController(Controller: StimulusControllerConstructor) {
  return createHtmlAutocompleteController(Controller, {
    optionSelector: ".agent-template-option",
    triggerKeysWhenClosed: ["/"],
    query(input) {
      const before = input.value.slice(0, input.selectionStart ?? 0);
      const after = input.value.slice(input.selectionEnd ?? 0);
      if (after && !/^\s/.test(after)) return undefined;
      const match = before.match(/^\/([^\s]*)$/);
      return match ? match[1] : undefined;
    },
    select(option, input) {
      const trigger = option.dataset.templateTrigger;
      if (!trigger) return;
      const end = input.selectionEnd ?? 0;
      const before = input.value.slice(0, input.selectionStart ?? 0);
      const after = input.value.slice(end);
      const start = before.match(/^\/[^\s]*$/)?.index ?? 0;
      input.value = `${input.value.slice(0, start)}${trigger} ${after}`;
      const cursor = start + trigger.length + 1;
      input.setSelectionRange(cursor, cursor);
    },
    keydown(event, input, url, actions) {
      if (event.key !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
      if (!input.value.trim().match(/^\/[^\s]+(?:\s+[\s\S]*)?$/)) return false;
      event.preventDefault();
      const body = new FormData();
      body.set("text", input.value);
      void fetch(`${url}/expand`, { method: "POST", body, headers: { Accept: "text/plain" } })
        .then((response) => response.text())
        .then((expanded) => {
          actions.setInputValue(expanded);
          actions.close();
        });
      return true;
    },
  });
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
// Tab visibility hook
// ---------------------------------------------------------------------------

function agentPaneController(application: StimulusApplication, pane: HTMLElement): AgentPaneControllerInstance | null {
  const agentPane = pane.querySelector<HTMLElement>('[data-controller~="agent-pane"]');
  return agentPane ? application.getControllerForElementAndIdentifier(agentPane, "agent-pane") as AgentPaneControllerInstance | null : null;
}

function agentTabBecameVisible(application: StimulusApplication, pane: HTMLElement): void {
  agentPaneController(application, pane)?.start();
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
    application.register("agent-notice", createAgentNoticeController(Controller));
    application.register("agent-prompt-templates", createAgentPromptTemplatesController(Controller));
    application.register("agent-proxy", createAgentProxyController(Controller));
    application.register("agent-term", createAgentTermController(Controller));

    hooks.registerPaletteProvider({
      id: "agent.sessions",
      label: "Agent session",
      search: ({ fuzzyScore }) => agentPaletteItems(fuzzyScore),
    });
    hooks.onBecomeVisible(({ pane }) => agentTabBecameVisible(application, pane));
    hooks.onNoLongerVisible(({ pane }) => agentTabNoLongerVisible(application, pane));
    hooks.onFocusGroup(({ pane }) => {
      const agentInput = pane?.querySelector<HTMLTextAreaElement>(".agent-input");
      if (!agentInput) return false;
      agentInput.focus();
      return true;
    });
    hooks.onWorkspaceCommand((commandId) => {
      if (commandId !== "agent.launch-project-workspace") return false;
      const resident = document.querySelector<HTMLElement>(".workspace-detail-resident.visible");
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
