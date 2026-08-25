/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";

export class WorkspaceNameScrollController extends Controller<HTMLElement> {

  connect(): void {
    this.element.addEventListener("mouseenter", this.start);
    this.element.addEventListener("mouseleave", this.stop);
  }

  disconnect(): void {
    this.element.removeEventListener("mouseenter", this.start);
    this.element.removeEventListener("mouseleave", this.stop);
  }

  private readonly start = (): void => {
    const viewport = this.element.querySelector<HTMLElement>(".fixed-shell-workspace-name")!;
    const name = viewport.querySelector<HTMLElement>(":scope > span")!;
    const distance = name.scrollWidth - viewport.clientWidth;
    if (distance <= 0) return;
    this.element.style.setProperty("--workspace-name-scroll-distance", `${distance}px`);
    this.element.style.setProperty("--workspace-name-scroll-slow-distance", `${distance * 0.9}px`);
    this.element.style.setProperty("--workspace-name-scroll-duration", `${Math.max(2.5, distance / 28 + 1.2)}s`);
    this.element.classList.add("is-name-scrolling");
  };

  private readonly stop = (): void => {
    this.element.classList.remove("is-name-scrolling");
  };
}
