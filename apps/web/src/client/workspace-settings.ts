import type { ToggleChangeEvent } from "@atelier/design-system/toggle/client";
import { Controller } from "@hotwired/stimulus";
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

class SettingsAutosaveController extends Controller<HTMLFormElement> {
  private savedValues = "";
  private pending?: Promise<boolean>;

  connect(): void {
    this.savedValues = this.values();
  }

  private values(): string {
    return JSON.stringify([...new FormData(this.element).entries()]);
  }

  toggleChanged(event: ToggleChangeEvent): void {
    this.element.querySelector<HTMLInputElement>(`input[type="hidden"][name="${CSS.escape(event.detail.name)}"]`)!.value = event.detail.value;
    if (this.element.checkValidity()) void this.save();
  }

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

  save(): Promise<boolean> {
    // Every caller joins the same drain. Only its owner starts requests or clears pending.
    return this.pending ??= Promise.resolve().then(() => this.drain()).finally(() => { this.pending = undefined; });
  }

  private async drain(): Promise<boolean> {
    while (this.element.isConnected) {
      const data = new FormData(this.element);
      const values = JSON.stringify([...data.entries()]);
      if (values === this.savedValues) return true;
      if (!this.element.reportValidity()) return false;
      if (!await this.persist(data, values)) return false;
    }
    return true;
  }

  private async persist(data: FormData, values: string): Promise<boolean> {
    this.dispatch("saving");
    try {
      const response = await fetch(this.element.action, {
        method: this.element.method || "POST",
        body: data,
        headers: { Accept: "text/vnd.turbo-stream.html" },
      });
      const html = await response.text();
      if (response.ok) this.savedValues = values;
      this.dispatch(response.ok ? "saved" : "failed");
      window.Turbo!.renderStreamMessage(html);
      return response.ok;
    } catch (error) {
      this.dispatch("failed");
      throw error;
    }
  }
}

class ProjectSettingsController extends Controller<HTMLDialogElement> {
  static targets = ["status", "confirm"];
  declare readonly statusTarget: HTMLElement;
  declare readonly confirmTarget: HTMLButtonElement;

  saving(): void { this.statusTarget.textContent = "Saving…"; }
  saved(): void { this.statusTarget.textContent = "✓ Changes saved."; }
  failed(): void { this.statusTarget.textContent = "Changes could not be saved. Please try again."; }

  async complete(): Promise<void> {
    this.confirmTarget.disabled = true;
    try {
      const controllers = [...this.element.querySelectorAll<HTMLFormElement>('form[data-controller~="settings-autosave"]')].map((form) => {
        const controller = this.application.getControllerForElementAndIdentifier(form, "settings-autosave");
        if (!(controller instanceof SettingsAutosaveController)) throw new Error("Settings autosave controller is not connected");
        return controller;
      });
      for (const controller of controllers) {
        if (!await controller.save()) {
          this.statusTarget.textContent = "Please check your changes before closing.";
          return;
        }
      }
      this.element.close();
    } finally {
      this.confirmTarget.disabled = false;
    }
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

export function registerWorkspaceSettingsControllers(): void {
  registerWorkspaceControllers({
    "theme-select": ThemeSelectController,
    "git-identity": GitIdentityController,
    "settings-autosave": SettingsAutosaveController,
    "project-settings": ProjectSettingsController,
    "settings-prefetch": SettingsPrefetchController,
    "server-filter": ServerFilterController,
  });
}
