/// <reference lib="dom" />

import type { ActivityButtonState } from "./activity-button-html.ts";

/** Updates the activity state and its corresponding busy semantics. */
export function setActivityButtonState(button: HTMLButtonElement, state: ActivityButtonState): void {
  button.dataset.activityState = state;
  if (state === "active") button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}
