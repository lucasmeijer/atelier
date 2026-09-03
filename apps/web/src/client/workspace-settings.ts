import { Controller } from "@hotwired/stimulus";
import { showTransientFeedback } from "@atelier/design-system/transient-feedback/client";
import { copyTextToClipboard } from "@atelier/shared";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

class ThemeSelectController extends Controller<HTMLSelectElement> {
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

class OAuthFlowController extends Controller<HTMLElement> {
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

class SettingsAutosaveController extends Controller<HTMLFormElement> {
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

class GitIdentityController extends Controller<HTMLFormElement> {
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

class AgentModelSetupController extends Controller<HTMLElement> {
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

export function registerWorkspaceSettingsControllers(): void {
  registerWorkspaceControllers({
    "theme-select": ThemeSelectController,
    "oauth-flow": OAuthFlowController,
    "git-identity": GitIdentityController,
    "settings-autosave": SettingsAutosaveController,
    "settings-prefetch": SettingsPrefetchController,
    "server-filter": ServerFilterController,
    "model-catalogue": ModelCatalogueController,
    "onboarding": OnboardingController,
    "clipboard": ClipboardController,
    "agent-model-setup": AgentModelSetupController,
  });
}
