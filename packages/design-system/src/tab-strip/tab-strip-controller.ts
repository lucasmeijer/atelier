import { Controller } from "@hotwired/stimulus";

export class TabStripController extends Controller<HTMLElement> {
  private observer = new MutationObserver(() => this.sync());
  connect() {
    this.element.addEventListener("keydown", this.keydown);
    this.observer.observe(this.element, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected"] });
    this.sync();
  }
  disconnect() { this.observer.disconnect(); this.element.removeEventListener("keydown", this.keydown); }
  private tabs() { return [...this.element.querySelectorAll<HTMLElement>('[role="tab"]')]; }
  private sync() { for (const tab of this.tabs()) tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1; }
  private keydown = (event: KeyboardEvent) => {
    const tab = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="tab"]') : null;
    if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = this.tabs();
    if (tabs.length < 2) return;
    event.preventDefault();
    const rtl = getComputedStyle(this.element).direction === "rtl";
    const direction = (event.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab) + direction + tabs.length) % tabs.length;
    tabs[next]!.click(); tabs[next]!.focus();
  };
}
