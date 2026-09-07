import { Controller } from "@hotwired/stimulus";
import { actionItemElement, actionItemHtml } from "@atelier/design-system/action-item";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { escapeHtml, type WorkspaceClientCommand, type WorkspacePaletteItem } from "@atelier/shared";
import { submitFormWithFirstButton } from "./form-submission.ts";
import { cableRequestHeaders } from "./workspace-cable.ts";
import { clientHooks, type PaletteResult } from "./workspace-client-hooks.ts";
import { registerWorkspaceControllers, residencyController, workspaceNavigationController } from "./workspace-controller-registry.ts";

type WorkspaceCommandRegistration = Omit<WorkspaceClientCommand, "run">;

class AtelierShortcutsController extends Controller<HTMLElement> {
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

  private currentCommands(): WorkspaceClientCommand[] {
    const commands = new Map<string, WorkspaceClientCommand>(
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

  async runCommand(event: Event): Promise<void> {
    // SAFETY: This action is attached only to server-rendered command buttons whose registered command ID is in the dataset.
    const commandId = (event.currentTarget as HTMLElement).dataset.commandId!;
    const command = this.currentCommands().find((candidate) => candidate.id === commandId)!;
    await command.run();
  }

  private visibleWorkspaceDeleteCommands(): WorkspaceClientCommand[] {
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
      .filter((command): command is WorkspaceClientCommand & { binding: string } => Boolean(command.binding))
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
        element: { tag: "button",  attributesHtml: 'type="button"' },
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
    const template = document.createElement("template");
    template.innerHTML = dialogHtml({
      element: {  },
      iconHtml: Icons.Search,
      titleCaption: "Command palette",
      bodyHtml: `<label>Search commands, workspaces, and destinations
        <input class="text-field palette-input" id="atelier-palette-input" type="search" role="combobox" spellcheck="false" autocomplete="off" aria-label="Search command palette" aria-autocomplete="list" aria-controls="atelier-palette-results" aria-expanded="true">
      </label><div class="palette-results action-list" id="atelier-palette-results" role="listbox" aria-label="Command palette results"></div>`,
    });
    // SAFETY: dialogHtml always renders a native dialog as its root.
    const dialog = template.content.firstElementChild as HTMLDialogElement;
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
    return [...document.querySelectorAll<HTMLElement>("[data-workspace-entry-id]")];
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
    return document.querySelector<HTMLElement>("[data-workspace-entry-id][aria-current=\"page\"][data-workspace-entry-id]")?.dataset.workspaceEntryId
      ?? residencyController()?.visibleWorkspaceId();
  }

  async openPreparedAttentionWorkspace(): Promise<void> {
    const workspaceId = residencyController()?.oldestPreparedAttentionWorkspaceId();
    if (workspaceId) await workspaceNavigationController()?.selectWorkspaceById(workspaceId);
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

export function registerWorkspaceShortcutsController(): void {
  registerWorkspaceControllers({
    "atelier-shortcuts": AtelierShortcutsController,
  });
}
