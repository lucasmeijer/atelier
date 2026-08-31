/// <reference lib="dom" />

import { Controller } from "@hotwired/stimulus";

export interface ToggleChangeDetail {
  name: string;
  value: string;
}

export type ToggleChangeEvent = CustomEvent<ToggleChangeDetail>;

function toggleOptions(element: HTMLElement): HTMLButtonElement[] {
  return Array.from(element.querySelectorAll<HTMLButtonElement>("button[aria-pressed][value]"));
}

/** Updates a rendered toggle without firing its user-initiated change event. */
export function setToggleValue(element: HTMLElement, value: string): HTMLButtonElement {
  const options = toggleOptions(element);
  const selected = options.filter((option) => option.value === value);
  if (selected.length !== 1) throw new Error(`Expected one toggle option with value: ${value}`);
  for (const option of options) option.setAttribute("aria-pressed", String(option === selected[0]));
  return selected[0]!;
}

export class ToggleController extends Controller<HTMLElement> {
  private resizeObserver?: ResizeObserver;
  private selectionObserver?: MutationObserver;
  private readyFrame?: number;

  connect(): void {
    this.element.addEventListener("click", this.selectFromClick);
    this.element.addEventListener("keydown", this.selectFromKeyboard);
    if (!this.element.classList.contains("text-toggle")) return;
    this.positionIndicator();
    this.resizeObserver = new ResizeObserver(() => this.positionIndicator());
    this.resizeObserver.observe(this.element);
    this.selectionObserver = new MutationObserver(() => this.positionIndicator());
    this.selectionObserver.observe(this.element, { attributes: true, attributeFilter: ["aria-pressed"], subtree: true });
    this.readyFrame = requestAnimationFrame(() => this.element.setAttribute("data-text-toggle-ready", ""));
  }

  disconnect(): void {
    this.element.removeEventListener("click", this.selectFromClick);
    this.element.removeEventListener("keydown", this.selectFromKeyboard);
    this.resizeObserver?.disconnect();
    this.selectionObserver?.disconnect();
    if (this.readyFrame !== undefined) cancelAnimationFrame(this.readyFrame);
  }

  private enabledOptions(): HTMLButtonElement[] {
    return toggleOptions(this.element).filter((option) => !option.disabled);
  }

  private select(option: HTMLButtonElement): void {
    if (option.getAttribute("aria-pressed") === "true") return;
    setToggleValue(this.element, option.value);
    if (this.resizeObserver) this.positionIndicator(option);
    this.element.dispatchEvent(new CustomEvent<ToggleChangeDetail>("change", {
      bubbles: true,
      detail: { name: option.name, value: option.value },
    }));
  }

  private readonly positionIndicator = (selected = this.element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')): void => {
    if (!selected) return;
    this.element.style.setProperty("--text-toggle-indicator-left", `${selected.offsetLeft}px`);
    this.element.style.setProperty("--text-toggle-indicator-width", `${selected.offsetWidth}px`);
  };

  private readonly selectFromClick = (event: MouseEvent): void => {
    const option = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[aria-pressed]:not(:disabled)") : null;
    if (option && this.element.contains(option)) this.select(option);
  };

  private readonly selectFromKeyboard = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const options = this.enabledOptions();
    const current = event.target instanceof HTMLButtonElement ? options.indexOf(event.target) : -1;
    if (current < 0) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = options[(current + direction + options.length) % options.length]!;
    if (next.type === "submit") next.click();
    else this.select(next);
    next.focus();
  };
}
