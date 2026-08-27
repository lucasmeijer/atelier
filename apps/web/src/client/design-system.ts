/// <reference lib="dom" />

import { Application, Controller } from "@hotwired/stimulus";
import { copyTextToClipboard } from "@atelier/shared";
import { ActionItemsController } from "./action-items.ts";
import { PopupSelectController } from "./popup-select.ts";

class DialogController extends Controller<HTMLDialogElement> {
  private opener?: HTMLElement;

  connect(): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.element.addEventListener("close", this.restoreFocus);
    if (this.element.hasAttribute("data-dialog-auto-show") && !this.element.open) {
      this.element.showModal();
      requestAnimationFrame(() => this.element.querySelector<HTMLElement>("[autofocus], button, input, select, textarea")?.focus());
    }
  }

  disconnect(): void {
    this.element.removeEventListener("close", this.restoreFocus);
  }

  private readonly restoreFocus = (): void => {
    this.opener?.focus();
  };
}

class ManagedListController extends Controller<HTMLElement> {
  private input?: HTMLInputElement;

  connect(): void {
    this.input = this.element.querySelector<HTMLInputElement>(".managed-list__filter input") ?? undefined;
    if (!this.input) return;
    this.input.addEventListener("input", this.filter);
    this.filter();
  }

  disconnect(): void {
    this.input?.removeEventListener("input", this.filter);
  }

  private readonly filter = (): void => {
    const query = this.input!.value.trim().toLowerCase();
    const items = Array.from(this.element.querySelectorAll<HTMLElement>(".managed-list__item"));
    let matches = 0;
    for (const item of items) {
      const searchText = (item.dataset.searchText ?? item.textContent ?? "").toLowerCase();
      const match = !query || searchText.includes(query);
      item.hidden = !match;
      if (match) matches += 1;
    }
    const empty = this.element.querySelector<HTMLElement>(".managed-list__empty");
    if (empty) empty.hidden = matches > 0;
  };
}

class CopyButtonController extends Controller<HTMLButtonElement> {
  private timer?: ReturnType<typeof setTimeout>;

  connect(): void {
    this.element.addEventListener("click", this.copy);
  }

  disconnect(): void {
    this.element.removeEventListener("click", this.copy);
    if (this.timer) clearTimeout(this.timer);
  }

  private readonly copy = async (event: MouseEvent): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    const source = this.element.closest(".copy-region")!.querySelector<HTMLElement>("[data-copy-source]")!;
    const text = source.innerText;
    if (!text) return;
    if (this.timer) clearTimeout(this.timer);
    const icon = this.element.querySelector<HTMLElement>(".copy-button__icon")!;
    const label = this.element.dataset.copyLabel!;
    this.element.dataset.copyState = "copied";
    this.element.setAttribute("aria-label", "Copied to clipboard");
    icon.textContent = "✓";
    this.timer = setTimeout(() => {
      delete this.element.dataset.copyState;
      this.element.setAttribute("aria-label", label);
      icon.textContent = "⧉";
    }, 1000);
    await copyTextToClipboard(text);
  };
}

class ToggleController extends Controller<HTMLElement> {
  private resizeObserver?: ResizeObserver;
  private readyFrame?: number;

  connect(): void {
    this.element.addEventListener("click", this.selectFromClick);
    this.element.addEventListener("keydown", this.selectFromKeyboard);
    if (!this.element.classList.contains("text-toggle")) return;
    this.positionIndicator();
    this.resizeObserver = new ResizeObserver(() => this.positionIndicator());
    this.resizeObserver.observe(this.element);
    this.readyFrame = requestAnimationFrame(() => this.element.setAttribute("data-text-toggle-ready", ""));
  }

  disconnect(): void {
    this.element.removeEventListener("click", this.selectFromClick);
    this.element.removeEventListener("keydown", this.selectFromKeyboard);
    this.resizeObserver?.disconnect();
    if (this.readyFrame !== undefined) cancelAnimationFrame(this.readyFrame);
  }

  private options(): HTMLButtonElement[] {
    return Array.from(this.element.querySelectorAll<HTMLButtonElement>("button[aria-pressed]:not(:disabled)"));
  }

  private select(option: HTMLButtonElement): void {
    for (const candidate of this.options()) candidate.setAttribute("aria-pressed", String(candidate === option));
    if (this.resizeObserver) this.positionIndicator(option);
    option.dispatchEvent(new Event("change", { bubbles: true }));
  }

  private readonly positionIndicator = (selected = this.element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')): void => {
    if (!selected) return;
    this.element.style.setProperty("--text-toggle-indicator-left", `${selected.offsetLeft}px`);
    this.element.style.setProperty("--text-toggle-indicator-width", `${selected.offsetWidth}px`);
  };

  private readonly selectFromClick = (event: MouseEvent): void => {
    const option = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[aria-pressed]:not(:disabled)") : null;
    if (option && this.element.contains(option)) this.select(option);
  };

  private readonly selectFromKeyboard = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const options = this.options();
    const current = event.target instanceof HTMLButtonElement ? options.indexOf(event.target) : -1;
    if (current < 0) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = options[(current + direction + options.length) % options.length]!;
    this.select(next);
    next.focus();
  };
}

class PopupMenuController extends Controller<HTMLElement> {
  private trigger!: HTMLButtonElement;
  private menu!: HTMLElement;
  private ownsBehavior = false;

  connect(): void {
    this.trigger = this.element.querySelector<HTMLButtonElement>(".popup-menu-trigger")!;
    this.menu = this.element.querySelector<HTMLElement>(".popup-menu")!;
    this.ownsBehavior = !this.menu.hasAttribute("popover") && !this.menu.dataset.popupSelectMenu;
    if (!this.ownsBehavior) return;
    this.trigger.addEventListener("click", this.toggle);
    this.menu.addEventListener("click", this.choose);
    this.element.addEventListener("keydown", this.keydown);
    document.addEventListener("click", this.closeFromOutside);
  }

  disconnect(): void {
    if (!this.ownsBehavior) return;
    this.trigger.removeEventListener("click", this.toggle);
    this.menu.removeEventListener("click", this.choose);
    this.element.removeEventListener("keydown", this.keydown);
    document.removeEventListener("click", this.closeFromOutside);
  }

  private open(): void {
    this.menu.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.menu.querySelector<HTMLElement>("[role^='menuitem']:not(:disabled)")?.focus();
  }

  private close(): void {
    this.menu.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
  }

  private readonly toggle = (event: MouseEvent): void => {
    event.stopPropagation();
    if (this.trigger.getAttribute("aria-expanded") === "true") this.close();
    else this.open();
  };

  private readonly choose = (event: MouseEvent): void => {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>("[role^='menuitem']:not(:disabled)") : null;
    if (!item) return;
    if (item.getAttribute("role") === "menuitemradio") {
      for (const candidate of this.menu.querySelectorAll<HTMLElement>("[role='menuitemradio']")) candidate.setAttribute("aria-checked", String(candidate === item));
    }
    this.close();
    this.trigger.focus();
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.trigger.getAttribute("aria-expanded") === "true") {
      event.preventDefault();
      this.close();
      this.trigger.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(this.menu.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)"));
    const current = event.target instanceof HTMLElement ? items.indexOf(event.target) : -1;
    if (current < 0) return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    items[(current + direction + items.length) % items.length]!.focus();
  };

  private readonly closeFromOutside = (event: MouseEvent): void => {
    if (event.target instanceof Node && !this.element.contains(event.target)) this.close();
  };
}

const automaticBehaviors = [
  ["body", "action-items"],
  [".copy-button", "copy-button"],
  [".dialog", "dialog"],
  [".managed-list", "managed-list"],
  [".popup-menu-anchor", "popup-menu"],
  [".popup-select", "popup-select"],
  [".button-toggle", "button-toggle"],
  [".text-toggle", "text-toggle"],
] as const;

function attachAutomaticBehaviors(root: ParentNode): void {
  for (const [selector, identifier] of automaticBehaviors) {
    const elements = [
      ...(root instanceof Element && root.matches(selector) ? [root] : []),
      ...root.querySelectorAll<HTMLElement>(selector),
    ];
    for (const element of elements) {
      const controllers = new Set((element.getAttribute("data-controller") ?? "").split(/\s+/).filter(Boolean));
      controllers.add(identifier);
      element.setAttribute("data-controller", [...controllers].join(" "));
    }
  }
}

export function registerDesignSystemControllers(application: Pick<Application, "register">): void {
  application.register("action-items", ActionItemsController);
  application.register("copy-button", CopyButtonController);
  application.register("dialog", DialogController);
  application.register("managed-list", ManagedListController);
  application.register("popup-menu", PopupMenuController);
  application.register("popup-select", PopupSelectController);
  application.register("button-toggle", ToggleController);
  application.register("text-toggle", ToggleController);
  attachAutomaticBehaviors(document);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) attachAutomaticBehaviors(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
}
