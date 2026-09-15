import { animateWarningChanges } from "../src/warning-banner/warning-banner-controller.ts";
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
  openDialog(event: Event & { params: { dialog: string } }): void {
    this.element
      .querySelector<HTMLDialogElement>(`#${event.params.dialog}`)!
      .showModal();
  }
  feedback(event: Event): void {
    // SAFETY: Stimulus invokes this action on the feedback button.
    showTransientFeedback(event.currentTarget as HTMLElement);
  }
  progress(event: Event & { params: { progress: string } }): void {
    const button = this.element.querySelector<HTMLButtonElement>("#motion-progress")!;
    const running = event.params.progress !== "idle";
    button.dataset.progressState = running ? "in-progress" : "initial";
    button.disabled = running;
    if (running) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
    button.style.setProperty("--button-progress", running ? event.params.progress : "0");
  }
  suggestions(event: Event): void {
    const results = this.element.querySelector<HTMLElement>("#motion-suggestions")!;
    results.hidden = !results.hidden;
    // SAFETY: This action belongs to the specimen's preview button.
    (event.currentTarget as HTMLElement).setAttribute("aria-expanded", String(!results.hidden));
  }
  async dismissWarning(event: Event): Promise<void> {
    event.preventDefault();
    const region = this.element.querySelector<HTMLElement>("#motion-warning-region")!;
    region.querySelector<HTMLElement>(":popover-open")?.hidePopover();
    await animateWarningChanges([region], () => { region.querySelector<HTMLElement>(".warning-banner")!.hidden = true; });
    this.element.querySelector<HTMLButtonElement>("#motion-warning-reset")!.focus();
  }
  async resetWarning(): Promise<void> {
    const region = this.element.querySelector<HTMLElement>("#motion-warning-region")!;
    await animateWarningChanges([region], () => { region.querySelector<HTMLElement>(".warning-banner")!.hidden = false; });
  }
  submit(event: Event): void {
    event.preventDefault();
    // SAFETY: Catalogue submit actions are bound to the element containing the demo and its output.
    const demo = event.currentTarget as HTMLElement;
    demo.querySelector<HTMLElement>(":popover-open")?.hidePopover();
    demo.querySelector("output")!.textContent =
      "Submitted — demo only. Nothing was deleted.";
  }
}
const application = Application.start();
registerDesignSystemControllers(application);
application.register("catalogue", CatalogueController);

application.register("catalogue-reload", CatalogueReloadController);
