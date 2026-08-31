/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";
import { copyTextToClipboard } from "@atelier/shared";
import { showTransientFeedback } from "../transient-feedback/transient-feedback-controller.ts";

export class CopyButtonController extends Controller<HTMLButtonElement> {
  async copy(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const source = this.element.closest(".copy-region")?.querySelector<HTMLElement>("[data-copy-source]");
    const text = this.element.hasAttribute("data-copy-text") ? this.element.dataset.copyText! : source?.innerText;
    if (text === undefined || (source && !text)) return;
    await copyTextToClipboard(text);
    showTransientFeedback(this.element);
  }
}
