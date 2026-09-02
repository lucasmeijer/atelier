/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";
import { actionItemElement } from "../action-item/action-item-html.ts";
import { buttonElement } from "../button/button-html.ts";

let menuSequence = 0;

/** Synchronizes menu selection and disclosure state around the native Popover API. */
export class PopupController extends Controller<HTMLElement> {
  private trigger!: HTMLButtonElement;
  private menu!: HTMLElement;

  connect(): void {
    this.trigger = this.element.querySelector<HTMLButtonElement>("[data-popup-menu-trigger]")!;
    this.menu = this.element.querySelector<HTMLElement>(".popup-menu[popover]")!;
    this.menu.addEventListener("click", this.choose);
    this.menu.addEventListener("toggle", this.syncOpenState);
    this.menu.addEventListener("keydown", this.keydown);
  }

  disconnect(): void {
    this.menu.removeEventListener("click", this.choose);
    this.menu.removeEventListener("toggle", this.syncOpenState);
    this.menu.removeEventListener("keydown", this.keydown);
  }

  private readonly syncOpenState = (event: ToggleEvent): void => {
    this.trigger.setAttribute("aria-expanded", String(event.newState === "open"));
  };

  private readonly choose = (event: MouseEvent): void => {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>("[role^='menuitem']:not(:disabled)") : null;
    if (!item) return;
    if (item.getAttribute("role") === "menuitemradio") {
      for (const candidate of this.menu.querySelectorAll<HTMLElement>("[role='menuitemradio']")) candidate.setAttribute("aria-checked", String(candidate === item));
    }
    this.menu.hidePopover();
    this.trigger.focus();
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(this.menu.querySelectorAll<HTMLElement>("[role^='menuitem']:not(:disabled)"));
    const current = event.target instanceof HTMLElement ? items.indexOf(event.target) : -1;
    if (current < 0) return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    items[(current + direction + items.length) % items.length]!.focus();
  };
}

/** Enhances a native select while preserving its form and change-event semantics. */
export class PopupSelectController extends Controller<HTMLSelectElement> {
  private button!: HTMLButtonElement;
  private menu!: HTMLDivElement;
  private anchor!: HTMLElement;
  private observer!: MutationObserver;

  connect(): void {
    this.anchor = this.element.parentElement!;
    this.anchor.classList.add("popup-menu-anchor");
    this.element.classList.add("popup-select-native");

    this.button = buttonElement({
      type: "button",
      variant: "secondary",
      content: { kind: "caption", caption: this.element.selectedOptions[0]?.textContent?.trim() || this.element.value },
      attributesHtml: "data-popup-menu-trigger data-popup-select-trigger",
    });
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");

    this.menu = document.createElement("div");
    this.menu.className = `floating-surface popup-menu action-list popup-menu-anchored${this.element.dataset.popupPlacement === "above" ? " opens-above" : ""}`;
    this.menu.id = `${this.element.id || `popup_select_${++menuSequence}`}_menu`;
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("popover", "auto");
    this.button.setAttribute("aria-controls", this.menu.id);
    this.button.setAttribute("popovertarget", this.menu.id);

    this.element.after(this.button, this.menu);
    this.element.addEventListener("change", this.sync);
    this.menu.addEventListener("toggle", this.syncOpenState);
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["selected", "disabled"] });
    this.sync();
  }

  disconnect(): void {
    this.element.removeEventListener("change", this.sync);
    this.menu.removeEventListener("toggle", this.syncOpenState);
    this.observer.disconnect();
    this.button.remove();
    this.menu.remove();
    this.element.classList.remove("popup-select-native");
    this.anchor.classList.remove("popup-menu-anchor");
  }

  private readonly sync = (): void => {
    const selected = this.element.selectedOptions[0];
    const selectedLabel = selected?.textContent?.trim() || this.element.value;
    this.button.textContent = selectedLabel;
    this.button.disabled = this.element.disabled;
    this.button.title = this.element.title;
    const accessibleName = this.element.getAttribute("aria-label") || this.element.title || "Options";
    this.button.setAttribute("aria-label", `${accessibleName}: ${selectedLabel}`);
    this.menu.setAttribute("aria-label", accessibleName);
    this.menu.replaceChildren(...Array.from(this.element.options, (option) => this.renderOption(option)));
  };

  private renderOption(option: HTMLOptionElement): HTMLButtonElement {
    const item = actionItemElement<HTMLButtonElement>({
      kind: "single",
      label: { kind: "text", text: option.textContent ?? option.value },
      element: { tag: "button", attributesHtml: `type="button" role="menuitemradio" aria-checked="${option.selected}"${option.disabled ? " disabled" : ""}` },
    });
    item.addEventListener("click", () => {
      this.element.value = option.value;
      this.element.dispatchEvent(new Event("change", { bubbles: true }));
      this.menu.hidePopover();
    });
    return item;
  }

  private readonly syncOpenState = (event: ToggleEvent): void => {
    this.button.setAttribute("aria-expanded", String(event.newState === "open"));
  };
}
