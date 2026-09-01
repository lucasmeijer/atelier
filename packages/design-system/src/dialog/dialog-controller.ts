/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";

/** Owns the native dialog lifecycle shared by server-rendered modal surfaces. */
export class DialogController extends Controller<HTMLDialogElement> {
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
