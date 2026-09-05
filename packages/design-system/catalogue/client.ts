import { setActivityButtonState } from "../src/activity-button/activity-button-client.ts";
import { CatalogueReloadController } from "./reload-controller.ts";
import { Application, Controller } from "@hotwired/stimulus";
import { registerDesignSystemControllers } from "../src/client.ts";
import { showTransientFeedback } from "../src/transient-feedback/transient-feedback-controller.ts";

function controlValue(event: Event): string {
  // SAFETY: These change actions are bound exclusively to native select elements.
  return (event.target as HTMLSelectElement).value;
}

/** Only browser-owned specimen controls; all example markup is server rendered. */
class CatalogueController extends Controller<HTMLElement> {
  static targets = ["entry", "nav", "status", "edge"];
  declare entryTargets: HTMLElement[];
  declare navTargets: HTMLAnchorElement[];
  declare statusTarget: HTMLElement;
  declare edgeTarget: HTMLElement;

  filter(event: Event): void {
    // SAFETY: The catalogue binds this action only to its declared native control.
    const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
    let count = 0;
    for (const entry of this.entryTargets) {
      entry.hidden = !entry.dataset.search!.includes(query);
      this.navTargets.find((link) => link.hash === `#${entry.id}`)!.hidden =
        entry.hidden;
      if (!entry.hidden) count++;
    }
    this.statusTarget.textContent = `${count} components${count ? "" : " — try another search"}`;
  }
  // SAFETY: The catalogue binds this action only to its declared native control.
  theme(event: Event): void {
    document.documentElement.dataset.theme = controlValue(event);
  }
  // SAFETY: The catalogue binds this action only to its declared native control.
  width(event: Event): void {
    this.element.style.setProperty("--example-width", controlValue(event));
  }
  direction(event: Event): void {
    // SAFETY: The catalogue binds this action only to its declared native control.
    for (const stage of this.element.querySelectorAll<HTMLElement>(
      ".catalogue-stage, .catalogue-edge",
    ))
      stage.dir = controlValue(event);
  }
  corner(event: Event): void {
    this.resetCorner();
    // SAFETY: The catalogue binds this action only to its declared native control.
    const position = controlValue(event);
    this.edgeTarget.dataset.corner = position;
    this.edgeTarget.hidden = !position;
  }
  resetCorner(): void {
    const menu = this.edgeTarget.querySelector<HTMLElement>("[popover]")!;
    if (menu.matches(":popover-open")) menu.hidePopover();
    this.edgeTarget.hidden = true;
  }
  activity(event: Event): void {
    // SAFETY: This action is bound only to the activity example buttons.
    const button = event.currentTarget as HTMLButtonElement;
    setActivityButtonState(button, button.dataset.activityState === "active" ? "initial" : "active");
  }
  openDialog(): void {
    this.element
      .querySelector<HTMLDialogElement>("#catalogue-dialog")!
      .showModal();
  }
  // SAFETY: The catalogue binds this action only to its declared native control.
  feedback(event: Event): void {
    // SAFETY: Stimulus invokes this action on the feedback button.
    showTransientFeedback(event.currentTarget as HTMLElement);
  }
  submit(event: Event): void {
    event.preventDefault();
    // SAFETY: This demo action is bound to the confirmation form.
    const form = event.target as HTMLFormElement;
    form.querySelector("output")!.textContent =
      "Submitted — demo only. Nothing was deleted.";
  }
}
const application = Application.start();
registerDesignSystemControllers(application);
application.register("catalogue", CatalogueController);

application.register("catalogue-reload", CatalogueReloadController);
