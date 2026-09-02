/// <reference lib="dom" />

import { actionItemElement, type ActionItemLabel } from "@atelier/design-system/action-item";
import { Controller } from "@hotwired/stimulus";

let menuSequence = 0;

function closeOtherMenus(except: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".popup-menu[data-popup-select-menu]:popover-open").forEach((menu) => {
    if (menu === except) return;
    menu.hidePopover();
    document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`)?.setAttribute("aria-expanded", "false");
  });
}

export abstract class SelectPopupController extends Controller<HTMLSelectElement> {
  protected button!: HTMLButtonElement;
  protected menu!: HTMLDivElement;
  private anchor!: HTMLElement;
  private observer!: MutationObserver;

  protected get triggerClass(): string { return "button secondary"; }
  protected get menuClass(): string { return ""; }
  protected get accessibleName(): string { return this.element.getAttribute("aria-label") || this.element.title || "Options"; }

  connect(): void {
    this.anchor = this.element.parentElement!;
    this.anchor.classList.add("popup-menu-anchor");
    this.element.classList.add("popup-select-native");

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = `${this.triggerClass} popup-select-trigger popup-menu-trigger`;
    this.button.setAttribute("aria-haspopup", "menu");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", this.toggle);

    this.menu = document.createElement("div");
    this.menu.className = `popup-menu action-list popup-menu-anchored${this.menuClass}`;
    this.menu.dataset.popupSelectMenu = "true";
    this.menu.id = `${this.element.id || `popup_select_${++menuSequence}`}_menu`;
    this.menu.setAttribute("role", "menu");
    this.menu.setAttribute("popover", "auto");
    this.button.setAttribute("aria-controls", this.menu.id);
    this.button.setAttribute("popovertarget", this.menu.id);

    this.element.after(this.button, this.menu);
    this.element.addEventListener("change", this.sync);
    this.menu.addEventListener("toggle", this.syncOpenState);
    document.addEventListener("atelier:theme-change", this.sync);
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(this.element, { childList: true, subtree: true, attributes: true, attributeFilter: ["selected", "disabled"] });
    this.sync();
  }

  disconnect(): void {
    this.button.removeEventListener("click", this.toggle);
    this.element.removeEventListener("change", this.sync);
    this.menu.removeEventListener("toggle", this.syncOpenState);
    document.removeEventListener("atelier:theme-change", this.sync);
    this.observer.disconnect();
    this.button.remove();
    this.menu.remove();
    this.element.classList.remove("popup-select-native");
    this.anchor.classList.remove("popup-menu-anchor");
  }

  protected readonly sync = (): void => {
    const selected = this.element.selectedOptions[0];
    const selectedLabel = selected?.textContent?.trim() || this.element.value;
    this.renderTrigger(selected, selectedLabel);
    this.button.disabled = this.element.disabled;
    this.button.title = this.element.title;
    this.button.setAttribute("aria-label", `${this.accessibleName}: ${selectedLabel}`);
    this.menu.setAttribute("aria-label", this.accessibleName);
    this.menu.replaceChildren(...this.renderMenu());
  };

  protected renderTrigger(_selected: HTMLOptionElement | undefined, label: string): void {
    this.button.textContent = label;
  }

  protected renderMenu(): Node[] {
    return Array.from(this.element.options, (option) => this.renderOption(option));
  }

  protected renderOption(option: HTMLOptionElement): HTMLButtonElement {
    const item = actionItemElement<HTMLButtonElement>({
      kind: "single",
      label: this.renderOptionLabel(option),
      element: { tag: "button", attributesHtml: `type="button" role="menuitemradio" aria-checked="${option.selected}"${option.disabled ? " disabled" : ""}` },
    });
    item.addEventListener("click", () => this.select(option));
    return item;
  }

  protected renderOptionLabel(option: HTMLOptionElement): ActionItemLabel {
    return { kind: "text", text: option.textContent ?? option.value };
  }

  protected select(option: HTMLOptionElement): void {
    this.element.value = option.value;
    this.element.dispatchEvent(new Event("change", { bubbles: true }));
    this.close();
  }

  protected canOpen(): boolean { return !this.element.disabled; }

  protected close(): void {
    if (this.menu.matches(":popover-open")) this.menu.hidePopover();
    this.button.setAttribute("aria-expanded", "false");
  }

  private toggle = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!this.canOpen()) return;
    const opening = !this.menu.matches(":popover-open");
    if (opening) {
      closeOtherMenus(this.menu);
      this.menu.showPopover();
    } else {
      this.menu.hidePopover();
    }
  };

  private readonly syncOpenState = (): void => {
    this.button.setAttribute("aria-expanded", String(this.menu.matches(":popover-open")));
  };
}

export class PopupSelectController extends SelectPopupController {
  protected override get triggerClass(): string {
    return this.element.dataset.popupSelectTriggerClass ?? super.triggerClass;
  }

  protected override get menuClass(): string {
    return this.element.dataset.popupSelectOpensAbove === "true" ? " opens-above" : "";
  }
}
