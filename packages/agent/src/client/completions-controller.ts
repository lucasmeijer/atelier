import { autocompleteHtml } from "@atelier/design-system/autocomplete";
import { composerSubmitKey, focusLikelyOpensSoftwareKeyboard, setTextInputValue, type WorkspaceClientCommand, type WorkspaceClientControllerConstructor as StimulusControllerConstructor, type WorkspaceClientHooks } from "@atelier/shared";
import { agentCompletionRequest, insertFileCompletion, insertSlashCommand } from "./completion-input.ts";
import { createHtmlAutocompleteController, type HtmlAutocompleteInteraction } from "./html-autocomplete-controller.ts";
import { handleAgentTreeKeydown, handleAgentTreeMenuEvent, selectAgentTreeOption } from "./session-tree.ts";

const treeComingSoonMessage = "/tree feature is coming soon!";

function showApplicationCommandNotice(input: HTMLInputElement | HTMLTextAreaElement, message: string): void {
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
    option.classList.add("shortcut-conflict");
    option.dataset.agentQuickLaunchShortcut = `⌘⌥${hotkey.toUpperCase()} used by ${conflict.label}`;
  }
  return container.innerHTML;
}

function filterSlashCompletionCatalog(html: string, query: string, compactAvailable: boolean): string {
  const container = document.createElement("template");
  container.innerHTML = html.trim();
  const menu = container.content.querySelector<HTMLElement>(".autocomplete")!;
  const compact = menu.querySelector<HTMLButtonElement>('[data-command-trigger="/compact"]');
  if (compact && !compactAvailable) {
    compact.disabled = true;
    compact.setAttribute("aria-disabled", "true");
    compact.querySelector<HTMLElement>(".action-item__label-text")!.textContent = "/compact [instructions] — Available after more conversation history.";
  }
  const normalized = query.toLowerCase();
  const options = [...menu.querySelectorAll<HTMLButtonElement>(":is(.agent-completion-option, [data-agent-completion-option])")]
    .filter((option) => option.dataset.commandTrigger!.slice(1).toLowerCase().includes(normalized))
    .sort((a, b) => {
      const aName = a.dataset.commandTrigger!.slice(1).toLowerCase();
      const bName = b.dataset.commandTrigger!.slice(1).toLowerCase();
      return Number(bName.startsWith(normalized)) - Number(aName.startsWith(normalized)) || aName.localeCompare(bName);
    })
    .slice(0, 12);

  if (options.length === 0) return autocompleteHtml({ kind: "message", content: { kind: "text", text: "No matching commands" } });
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

export function createAgentCompletionsController(Controller: StimulusControllerConstructor, hooks: WorkspaceClientHooks) {
  const HtmlAutocompleteController = createHtmlAutocompleteController(Controller, {
    optionSelector: ":is(.agent-completion-option, [data-agent-completion-option]):not([hidden]):not(:disabled)",
    loadingHtml: autocompleteHtml({ kind: "message", role: "status", content: { kind: "html", html: '<span class="agent-completion-spinner" aria-hidden="true"></span>Loading completions…' } }),
    triggerKeysWhenClosed: ["/", "@"],
    fullscreenShortcut: (option) => option.dataset.completionKind === "prompt-template",
    keepOpenOnBlur: (input, menu) => !composerIsTranscribing(input) && input.value === "" && Boolean(menu.querySelector("[data-agent-quick-launch]")),
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
      if (event.key === "ArrowUp" && input.value === "" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        actions.close();
        return false;
      }
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

