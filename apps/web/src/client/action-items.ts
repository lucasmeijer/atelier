/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";

const actionItemSelector = ".action-item";
const labelSelector = ".action-item__label";
const labelTextSelector = ".action-item__label-text";
const scrollingClass = "is-label-scrolling";

export class ActionItemsController extends Controller<HTMLElement> {
  connect(): void {
    this.element.addEventListener("mouseover", this.startLabelScroll);
    this.element.addEventListener("mouseout", this.stopPointerLabelScroll);
    this.element.addEventListener("focusin", this.startLabelScroll);
    this.element.addEventListener("focusout", this.stopFocusLabelScroll);
  }

  disconnect(): void {
    this.element.removeEventListener("mouseover", this.startLabelScroll);
    this.element.removeEventListener("mouseout", this.stopPointerLabelScroll);
    this.element.removeEventListener("focusin", this.startLabelScroll);
    this.element.removeEventListener("focusout", this.stopFocusLabelScroll);
  }

  private transitionedItem(event: MouseEvent | FocusEvent): HTMLElement | null {
    const item = event.target instanceof Element ? event.target.closest<HTMLElement>(actionItemSelector) : null;
    return item && !(event.relatedTarget instanceof Node && item.contains(event.relatedTarget)) ? item : null;
  }

  private readonly startLabelScroll = (event: MouseEvent | FocusEvent): void => {
    const item = this.transitionedItem(event);
    if (!item) return;
    const viewport = item.querySelector<HTMLElement>(labelSelector);
    const text = viewport?.querySelector<HTMLElement>(`:scope > ${labelTextSelector}`);
    if (!viewport || !text) return;
    const distance = text.scrollWidth - viewport.clientWidth;
    if (distance <= 0) return;
    item.style.setProperty("--action-item-label-scroll-distance", `${distance}px`);
    item.style.setProperty("--action-item-label-scroll-duration", `${Math.max(2.5, distance / 64 + 0.8)}s`);
    item.classList.add(scrollingClass);
  };

  private readonly stopPointerLabelScroll = (event: MouseEvent): void => {
    this.transitionedItem(event)?.classList.remove(scrollingClass);
  };

  private readonly stopFocusLabelScroll = (event: FocusEvent): void => {
    const item = this.transitionedItem(event);
    if (item && !item.matches(":hover")) item.classList.remove(scrollingClass);
  };
}
