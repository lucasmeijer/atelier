import { Controller } from "@hotwired/stimulus";
import { createHtmlAutocompleteController, PromptHistoryNavigator } from "@atelier/agent/client";
import { autocompleteHtml } from "@atelier/design-system/autocomplete";
import { composerSubmitKey, focusLikelyOpensSoftwareKeyboard, isWorkspacePaneVisible, looksLikeProjectSpec, phoneLayoutMediaQuery } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { submitFormWithFirstButton } from "./form-submission.ts";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

function focusDialogPromptEnd(dialog: ParentNode): void {
  const input = dialog.querySelector<HTMLTextAreaElement>("textarea");
  if (!input) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
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

  windowKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (composerSubmitKey(event, false) !== "shortcut") return;
    if (!isWorkspacePaneVisible(this.element) || !this.element.checkVisibility()) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    if (this.submitting) return;
    // SAFETY: Window-level shortcuts are attached to the form they submit.
    submitFormWithFirstButton(this.element as HTMLFormElement);
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

class ModalController extends Controller<HTMLDialogElement> {
  static values = { autoShow: Boolean };
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

class LaunchComposerDialogController extends Controller<HTMLDialogElement> {
  static values = { discardUrl: String };
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
    if (!window.matchMedia(phoneLayoutMediaQuery).matches || event.target !== this.element) return;
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

class ModalOpenerController extends Controller<HTMLElement> {
  static values = { targetId: String };
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

class AutoScrollController extends Controller<HTMLElement> {
  connect(): void {
    requestAnimationFrame(() => {
      this.element.scrollTop = this.element.scrollHeight;
    });
  }
}

class ScrollIntoViewController extends Controller<HTMLElement> {
  static values = { targetId: String };
  declare readonly targetIdValue: string;
  declare readonly hasTargetIdValue: boolean;

  connect(): void {
    this.scroll();
  }

  frameLoaded(event: Event): void {
    const target = this.hasTargetIdValue ? document.getElementById(this.targetIdValue)! : this.element;
    if (event.target instanceof Node && target.contains(event.target)) this.scroll();
  }

  private scroll(): void {
    const target = this.hasTargetIdValue ? document.getElementById(this.targetIdValue)! : this.element;
    requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
  }
}

const ProjectGithubSearchController = createHtmlAutocompleteController(Controller, {
  optionSelector: "[role=\"option\"]",
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

export function registerWorkspaceDialogControllers(): void {
  registerWorkspaceControllers({
    "submit-shortcut": SubmitShortcutController,
    "modal": ModalController,
    "modal-opener": ModalOpenerController,
    "launch-composer-dialog": LaunchComposerDialogController,
    "project-github-search": ProjectGithubSearchController,
    "auto-scroll": AutoScrollController,
    "scroll-into-view": ScrollIntoViewController,
  });
}
