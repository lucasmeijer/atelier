/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";

export class DestructiveConfirmationController extends Controller<HTMLElement> {
  private trigger!: HTMLElement;
  private triggerButton!: HTMLButtonElement;
  private decision!: HTMLElement;
  private cancelButton!: HTMLButtonElement;
  private resizeObserver!: ResizeObserver;
  private actionItem?: HTMLElement;

  connect(): void {
    this.trigger = this.element.querySelector<HTMLElement>(".destructive-confirmation__trigger")!;
    this.triggerButton = this.trigger.querySelector<HTMLButtonElement>("button")!;
    this.decision = this.element.querySelector<HTMLElement>(".destructive-confirmation__decision")!;
    this.cancelButton = this.element.querySelector<HTMLButtonElement>("[data-destructive-confirmation-cancel]")!;
    this.actionItem = this.element.closest<HTMLElement>(".action-item") ?? undefined;
    this.trigger.addEventListener("click", this.arm);
    this.cancelButton.addEventListener("click", this.cancel);
    this.element.addEventListener("keydown", this.keydown);
    this.resizeObserver = new ResizeObserver(this.measure);
    this.resizeObserver.observe(this.triggerButton);
    this.resizeObserver.observe(this.decision);
    this.measure();
    this.reset();
  }

  disconnect(): void {
    this.trigger.removeEventListener("click", this.arm);
    this.cancelButton.removeEventListener("click", this.cancel);
    this.element.removeEventListener("keydown", this.keydown);
    this.resizeObserver.disconnect();
    this.reset();
  }

  private readonly measure = (): void => {
    this.element.style.setProperty("--destructive-confirmation-trigger-width", `${this.triggerButton.offsetWidth}px`);
    this.element.style.setProperty("--destructive-confirmation-control-height", `${Math.max(this.triggerButton.offsetHeight, this.decision.offsetHeight)}px`);
  };

  private reset(focus = false): void {
    this.element.dataset.destructiveConfirmationState = "initial";
    this.actionItem?.style.removeProperty("--destructive-confirmation-action-item-width");
    this.actionItem?.style.removeProperty("--destructive-confirmation-action-item-growth");
    this.decision.inert = true;
    this.trigger.inert = false;
    if (focus) this.triggerButton.focus();
  }

  private readonly arm = (event: MouseEvent): void => {
    this.measure();
    if (this.actionItem) {
      const initialWidth = this.actionItem.getBoundingClientRect().width;
      const style = getComputedStyle(this.actionItem);
      const horizontalPadding = Number.parseFloat(style.paddingInlineStart) + Number.parseFloat(style.paddingInlineEnd);
      const expandedWidth = Math.max(initialWidth, this.decision.scrollWidth + horizontalPadding);
      this.actionItem.style.setProperty("--destructive-confirmation-action-item-width", `${expandedWidth}px`);
      this.actionItem.style.setProperty("--destructive-confirmation-action-item-growth", `${expandedWidth - initialWidth}px`);
    }
    this.element.dataset.destructiveConfirmationState = "confirming";
    this.decision.inert = false;
    if (this.trigger.contains(document.activeElement) || event.detail === 0) this.cancelButton.focus();
    this.trigger.inert = true;
  };

  private readonly cancel = (): void => {
    this.reset(true);
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.element.dataset.destructiveConfirmationState !== "confirming") return;
    event.preventDefault();
    this.reset(true);
  };
}
