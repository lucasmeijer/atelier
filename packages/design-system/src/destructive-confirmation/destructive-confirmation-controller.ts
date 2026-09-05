import { Controller } from "@hotwired/stimulus";

/** Two native form actions in normal flow; no caller layout measurement or overlay. */
export class DestructiveConfirmationController extends Controller<HTMLElement> {
  private trigger!: HTMLElement;
  private triggerButton!: HTMLButtonElement;
  private decision!: HTMLElement;
  private cancelButton!: HTMLButtonElement;

  connect(): void {
    this.trigger = this.element.querySelector<HTMLElement>(".destructive-confirmation__trigger")!;
    this.triggerButton = this.trigger.querySelector<HTMLButtonElement>("button")!;
    this.decision = this.element.querySelector<HTMLElement>(".destructive-confirmation__decision")!;
    this.cancelButton = this.decision.querySelector<HTMLButtonElement>("[data-destructive-confirmation-cancel]")!;
    this.triggerButton.addEventListener("click", this.arm);
    this.cancelButton.addEventListener("click", this.cancel);
    this.element.addEventListener("keydown", this.keydown);
    this.setConfirming(false);
  }

  disconnect(): void {
    this.triggerButton.removeEventListener("click", this.arm);
    this.cancelButton.removeEventListener("click", this.cancel);
    this.element.removeEventListener("keydown", this.keydown);
  }

  private setConfirming(confirming: boolean): void {
    this.element.dataset.destructiveConfirmationState = confirming ? "confirming" : "initial";
    this.trigger.inert = confirming;
    this.decision.inert = !confirming;
    this.triggerButton.setAttribute("aria-expanded", String(confirming));
  }

  private readonly arm = (): void => {
    this.setConfirming(true);
    this.cancelButton.focus();
  };
  private readonly cancel = (): void => {
    this.setConfirming(false);
    this.triggerButton.focus();
  };
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.element.dataset.destructiveConfirmationState !== "confirming") return;
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };
}
