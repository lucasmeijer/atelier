import { Controller } from "@hotwired/stimulus";

export class AtelierEasterEggController extends Controller<HTMLElement> {
  static targets = ["rest", "actor"];
  declare readonly restTarget: HTMLElement;
  declare readonly actorTarget: SVGSVGElement;

  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private readonly motionChanged = () => this.reset();

  connect(): void {
    this.reducedMotion.addEventListener("change", this.motionChanged);
  }

  play(): void {
    if (this.reducedMotion.matches || this.element.classList.contains("is-playing")) return;
    const logo = this.restTarget.querySelector("svg")!.getBoundingClientRect();
    this.actorTarget.style.width = `${logo.width}px`;
    this.actorTarget.style.height = `${logo.height}px`;
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
