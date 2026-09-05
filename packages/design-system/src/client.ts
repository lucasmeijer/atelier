/// <reference lib="dom" />

import { ManagedListController } from "./managed-list/managed-list-controller.ts";

import type { Application } from "@hotwired/stimulus";
import { ActionItemController } from "./action-item/action-item-controller.ts";
import { CopyButtonController } from "./copy-button/copy-button-controller.ts";
import { DestructiveConfirmationController } from "./destructive-confirmation/destructive-confirmation-controller.ts";
import { DialogController } from "./dialog/dialog-controller.ts";
import { LinearNavigationController } from "./linear-navigation/linear-navigation-controller.ts";
import { PopupController, PopupSelectController } from "./popup/popup-controller.ts";
import { TransientFeedbackController } from "./transient-feedback/transient-feedback-controller.ts";
import { ToggleController } from "./toggle/toggle-controller.ts";

const automaticBehaviors = [
  ["body", "action-items"],
  [".copy-button", "copy-button", "click->copy-button#copy"],
  [".destructive-confirmation", "destructive-confirmation"],
  [".dialog", "dialog"],
  [".managed-list", "managed-list"],
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
