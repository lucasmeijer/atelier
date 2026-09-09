import { Controller } from "@hotwired/stimulus";

export class AtelierEasterEggController extends Controller<HTMLElement> {
  static targets = ["rest", "actor"];
  declare readonly restTarget: HTMLElement;
  declare readonly actorTarget: HTMLElement;

  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private readonly motionChanged = () => this.reset();

  connect(): void {
    this.reducedMotion.addEventListener("change", this.motionChanged);
  }

  play(): void {
    if (this.reducedMotion.matches || this.element.classList.contains("is-playing")) return;
    const logo = this.restTarget.querySelector("svg")!.getBoundingClientRect();
    const header = this.element.closest(".panel__header")!.getBoundingClientRect();
    this.actorTarget.style.width = `${logo.width}px`;
    this.actorTarget.style.height = `${logo.height}px`;
    // Keep the excursion inside the header, including narrow Workspace panes.
    this.element.style.setProperty("--atelier-easter-egg-distance", `${Math.max(0, Math.min(148, header.right - logo.right - 28))}px`);
    this.element.classList.add("is-playing");
  }

  finish(event: AnimationEvent): void {
    if (event.animationName === "atelier-easter-egg-journey") this.reset();
  }

  reset(): void {
    this.element.classList.remove("is-playing");
  }

  disconnect(): void {
    this.reducedMotion.removeEventListener("change", this.motionChanged);
    this.reset();
  }
}
