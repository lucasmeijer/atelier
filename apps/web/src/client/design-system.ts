/// <reference lib="dom" />

import { Application, Controller } from "@hotwired/stimulus";
import { ActionItemController } from "@atelier/design-system/action-item/client";
import { CopyButtonController } from "@atelier/design-system/copy-button/client";
import { DestructiveConfirmationController } from "@atelier/design-system/destructive-confirmation/client";
import { DialogController } from "@atelier/design-system/dialog/client";
import { Icons } from "@atelier/design-system/icons";
import { LinearNavigationController } from "@atelier/design-system/linear-navigation/client";
import { PopupController, PopupSelectController } from "@atelier/design-system/popup/client";
import { TransientFeedbackController } from "@atelier/design-system/transient-feedback/client";
import { ToggleController } from "@atelier/design-system/toggle/client";

export function createCloseButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button secondary icon-only";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = Icons.Close;
  return button;
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

const automaticBehaviors = [
  ["body", "action-items"],
  [".copy-button", "copy-button", "click->copy-button#copy"],
  [".destructive-confirmation", "destructive-confirmation"],
  [".dialog", "dialog"],
  [".managed-list", "managed-list"],
  [".popup-menu-anchor:has(.popup-menu[popover])", "popup-menu"],
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
  application.register("linear-navigation", LinearNavigationController);
  application.register("managed-list", ManagedListController);
  application.register("popup-menu", PopupController);
  application.register("popup-select", PopupSelectController);
  application.register("toggle", ToggleController);
  application.register("transient-feedback", TransientFeedbackController);
  attachAutomaticBehaviors(document);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) attachAutomaticBehaviors(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
}
