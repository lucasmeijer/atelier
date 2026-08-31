/// <reference lib="dom" />

import { Application, Controller } from "@hotwired/stimulus";
import { ActionItemController } from "@atelier/design-system/action-item/client";
import { CopyButtonController } from "@atelier/design-system/copy-button/client";
import { DestructiveConfirmationController } from "@atelier/design-system/destructive-confirmation/client";
import { Icons } from "@atelier/design-system/icons";
import { TransientFeedbackController } from "@atelier/design-system/transient-feedback/client";
import { ToggleController } from "@atelier/design-system/toggle/client";
import { PopupSelectController } from "./popup-select.ts";

export function createCloseButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button secondary icon-only";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = Icons.Close;
  return button;
}

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
    if (this.element.dataset.managedListServerFilter === "true") return;
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

class PopupMenuController extends Controller<HTMLElement> {
  private trigger!: HTMLButtonElement;
  private menu!: HTMLElement;
  private usesNativePopover = false;

  connect(): void {
    this.trigger = this.element.querySelector<HTMLButtonElement>(".popup-menu-trigger")!;
    this.menu = this.element.querySelector<HTMLElement>(".popup-menu")!;
    this.usesNativePopover = this.menu.hasAttribute("popover");
    if (this.menu.dataset.popupSelectMenu) return;
    this.menu.addEventListener("click", this.choose);
    if (this.usesNativePopover) {
      this.menu.addEventListener("toggle", this.syncNativePopoverState);
      return;
    }
    this.trigger.addEventListener("click", this.toggle);
    this.element.addEventListener("keydown", this.keydown);
    document.addEventListener("click", this.closeFromOutside);
  }

  disconnect(): void {
    if (this.menu.dataset.popupSelectMenu) return;
    this.menu.removeEventListener("click", this.choose);
    if (this.usesNativePopover) {
      this.menu.removeEventListener("toggle", this.syncNativePopoverState);
      return;
    }
    this.trigger.removeEventListener("click", this.toggle);
    this.element.removeEventListener("keydown", this.keydown);
    document.removeEventListener("click", this.closeFromOutside);
  }

  private open(): void {
    this.menu.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.menu.querySelector<HTMLElement>("[role^='menuitem']:not(:disabled)")?.focus();
  }

  private close(): void {
    if (this.usesNativePopover) this.menu.hidePopover();
    else this.menu.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
  }

  private readonly syncNativePopoverState = (): void => {
    this.trigger.setAttribute("aria-expanded", String(this.menu.matches(":popover-open")));
  };

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
  [".copy-button", "copy-button", "click->copy-button#copy"],
  [".destructive-confirmation", "destructive-confirmation"],
  [".dialog", "dialog"],
  [".managed-list", "managed-list"],
  [".popup-menu-anchor", "popup-menu"],
  [".popup-select", "popup-select"],
] as const;

function attachAutomaticBehaviors(root: ParentNode): void {
  for (const [selector, identifier, action] of automaticBehaviors) {
    const elements = [
      ...(root instanceof Element && root.matches(selector) ? [root] : []),
      ...root.querySelectorAll<HTMLElement>(selector),
    ];
    for (const element of elements) {
      const controllers = new Set((element.getAttribute("data-controller") ?? "").split(/\s+/).filter(Boolean));
      controllers.add(identifier);
      element.setAttribute("data-controller", [...controllers].join(" "));
      if (action) {
        const actions = new Set((element.getAttribute("data-action") ?? "").split(/\s+/).filter(Boolean));
        actions.add(action);
        element.setAttribute("data-action", [...actions].join(" "));
      }
    }
  }
}

export function registerDesignSystemControllers(application: Pick<Application, "register">): void {
  application.register("action-items", ActionItemController);
  application.register("copy-button", CopyButtonController);
  application.register("destructive-confirmation", DestructiveConfirmationController);
  application.register("dialog", DialogController);
  application.register("managed-list", ManagedListController);
  application.register("popup-menu", PopupMenuController);
  application.register("popup-select", PopupSelectController);
  application.register("toggle", ToggleController);
  application.register("transient-feedback", TransientFeedbackController);
  attachAutomaticBehaviors(document);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) attachAutomaticBehaviors(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
}
