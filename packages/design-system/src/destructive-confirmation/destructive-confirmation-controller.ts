import { Controller } from "@hotwired/stimulus";
import { PopupPosition } from "../popup/popup-position.ts";

let confirmationSequence = 0;

/** A top-layer confirmation, with an in-flow opt-out and native form owner. */
export class DestructiveConfirmationController extends Controller<HTMLElement> {
  private triggerButton!: HTMLButtonElement;
  private confirmation!: HTMLElement;
  private initialLabel: string | null = null;
  private initialVariant!: string;
  private position!: PopupPosition;
  private entrance?: Animation;

  connect(): void {
    this.triggerButton = this.element.querySelector<HTMLButtonElement>(".destructive-confirmation__trigger")!;
    this.confirmation = this.element.querySelector<HTMLElement>(".destructive-confirmation__confirm")!;
    this.initialLabel = this.triggerButton.getAttribute("aria-label");
    this.initialVariant = ["primary", "secondary", "danger"].find((variant) => this.triggerButton.classList.contains(variant))!;
    this.confirmation.id = `destructive-confirmation-${++confirmationSequence}`;
    this.triggerButton.setAttribute("popovertarget", this.confirmation.id);
    this.triggerButton.setAttribute("aria-controls", this.confirmation.id);
    this.triggerButton.setAttribute("aria-expanded", "false");
    this.position = new PopupPosition(this.triggerButton, this.confirmation, "adjacent");
    this.confirmation.addEventListener("beforetoggle", this.prepareState);
    this.confirmation.addEventListener("toggle", this.syncOpenState);
  }

  disconnect(): void {
    this.finishEntrance();
    this.position.disconnect();
    this.confirmation.removeEventListener("beforetoggle", this.prepareState);
    this.confirmation.removeEventListener("toggle", this.syncOpenState);
  }

  // Let Cancel take its natural width before PopupPosition measures the open popover.
  private readonly prepareState = (event: ToggleEvent): void => {
    this.finishEntrance();
    const confirming = event.newState === "open";
    this.triggerButton.setAttribute("aria-expanded", String(confirming));
    this.triggerButton.classList.replace(confirming ? this.initialVariant : "secondary", confirming ? "secondary" : this.initialVariant);
    const label = confirming ? this.element.dataset.destructiveConfirmationCancelCaption! : this.initialLabel;
    for (const attribute of ["aria-label", "title"]) {
      if (label === null) this.triggerButton.removeAttribute(attribute);
      else this.triggerButton.setAttribute(attribute, label);
    }
  };

  private readonly syncOpenState = (): void => {
    if (this.confirmation.matches(":popover-open")) {
      this.triggerButton.focus({ preventScroll: true });
      this.animateEntrance();
    }
  };

  private animateEntrance(): void {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const origin = this.triggerButton.getBoundingClientRect();
    const destination = this.confirmation.getBoundingClientRect();
    const x = origin.left + origin.width / 2 - destination.left - destination.width / 2;
    const y = origin.top + origin.height / 2 - destination.top - destination.height / 2;
    // The moving button must never catch a second click intended for the opt-out.
    this.confirmation.inert = true;
    this.entrance = this.confirmation.animate([
      { transform: `translate(${x}px, ${y}px) scale(${Math.min(1, origin.width / destination.width)}, ${Math.min(1, origin.height / destination.height)})`, opacity: 0 },
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
    ], { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    this.entrance.onfinish = () => this.finishEntrance();
  }

  private finishEntrance(): void {
    this.entrance?.cancel();
    this.entrance = undefined;
    this.confirmation.inert = false;
  }
}
