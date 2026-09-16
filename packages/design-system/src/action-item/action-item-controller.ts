/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";

const actionItemSelector = ".action-item";
const labelSelector = ".action-item__label";
const labelTextSelector = ".action-item__label-text";
const scrollingClass = "is-label-scrolling";

export class ActionItemController extends Controller<HTMLElement> {
  connect(): void {
    this.element.addEventListener("mouseover", this.startLabelScroll);
    this.element.addEventListener("mouseout", this.stopPointerLabelScroll);
    this.element.addEventListener("focusin", this.startLabelScroll);
    this.element.addEventListener("focusout", this.stopFocusLabelScroll);
    this.element.addEventListener("turbo:before-morph-element", this.preserveLabelScroll);
  }

  disconnect(): void {
    this.element.removeEventListener("mouseover", this.startLabelScroll);
    this.element.removeEventListener("mouseout", this.stopPointerLabelScroll);
    this.element.removeEventListener("focusin", this.startLabelScroll);
    this.element.removeEventListener("focusout", this.stopFocusLabelScroll);
    this.element.removeEventListener("turbo:before-morph-element", this.preserveLabelScroll);
  }

  private readonly preserveLabelScroll = (event: Event): void => {
    const item = event.target;
    if (!(item instanceof HTMLElement) || !item.matches(`${actionItemSelector}.${scrollingClass}`)) return;
    // SAFETY: Turbo's before-morph-element event supplies newElement except for removals.
    const { newElement } = (event as CustomEvent<{ newElement?: Element }>).detail;
    if (!(newElement instanceof HTMLElement) || !newElement.matches(actionItemSelector)) return;
    // Merge only browser-owned animation state into the incoming markup. Keeping
    // the animation applied continuously preserves its progress, while allowing
    // server-owned classes, styles, and contents to morph normally.
    newElement.classList.add(scrollingClass);
    for (const property of ["--action-item-label-scroll-distance", "--action-item-label-scroll-duration"]) {
      newElement.style.setProperty(property, item.style.getPropertyValue(property));
    }
  };

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

/** Updates the plain label of an existing Action item without exposing its anatomy. */
export function setActionItemLabel(element: HTMLElement, text: string): void {
  element.querySelector<HTMLElement>(labelTextSelector)!.textContent = text;
}
