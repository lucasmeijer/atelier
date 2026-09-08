/// <reference lib="dom" />

/** One positioning lifecycle for menus, enhanced selects, and autocomplete, including fixed triggers
 * and the visual viewport when a phone keyboard or pinch zoom reduces usable space. */
export class PopupPosition {
  private readonly viewport = window.visualViewport!;
  private readonly resize = new ResizeObserver(() => this.position());

  constructor(private readonly trigger: HTMLElement, private readonly menu: HTMLElement) {
    menu.addEventListener("beforetoggle", this.prepare);
    menu.addEventListener("toggle", this.toggle);
  }

  disconnect(): void {
    this.stop();
    this.menu.removeEventListener("beforetoggle", this.prepare);
    this.menu.removeEventListener("toggle", this.toggle);
  }

  private readonly prepare = (event: ToggleEvent): void => {
    if (event.newState === "open") this.menu.style.visibility = "hidden";
  };

  private readonly toggle = (event: ToggleEvent): void => {
    if (event.newState === "closed") { this.stop(); return; }
    this.position();
    this.resize.observe(this.trigger);
    this.resize.observe(this.menu);
    document.addEventListener("scroll", this.scroll, true);
    window.addEventListener("resize", this.position);
    this.viewport.addEventListener("resize", this.position);
    this.viewport.addEventListener("scroll", this.position);
  };

  private stop(): void {
    this.resize.disconnect();
    document.removeEventListener("scroll", this.scroll, true);
    window.removeEventListener("resize", this.position);
    this.viewport.removeEventListener("resize", this.position);
    this.viewport.removeEventListener("scroll", this.position);
  }

  private readonly scroll = (event: Event): void => {
    if (event.target instanceof Node && this.menu.contains(event.target)) return;
    this.position();
  };

  private readonly position = (): void => {
    const gap = 8;
    const { offsetLeft, offsetTop, width, height } = this.viewport;
    const anchor = this.trigger.getBoundingClientRect();
    const bottom = offsetTop + height;
    if (anchor.bottom <= offsetTop || anchor.top >= bottom) {
      this.menu.hidePopover();
      return;
    }
    this.menu.style.maxWidth = `${Math.min(340, width - gap * 2)}px`;
    this.menu.style.minWidth = `${Math.min(anchor.width, width - gap * 2)}px`;
    const above = Math.max(0, anchor.top - offsetTop - gap * 2);
    const below = Math.max(0, bottom - anchor.bottom - gap * 2);
    const preferredAbove = this.menu.classList.contains("opens-above");
    const needed = Math.min(420, this.menu.scrollHeight + 2);
    const opensAbove = preferredAbove ? above >= needed || above > below : below < needed && above > below;
    this.menu.style.maxHeight = `${Math.min(420, opensAbove ? above : below)}px`;
    const surface = this.menu.getBoundingClientRect();
    const alignedLeft = getComputedStyle(this.trigger).direction === "rtl" ? anchor.right - surface.width : anchor.left;
    this.menu.style.left = `${Math.max(offsetLeft + gap, Math.min(alignedLeft, offsetLeft + width - surface.width - gap))}px`;
    this.menu.style.top = `${opensAbove ? anchor.top - gap - surface.height : anchor.bottom + gap}px`;
    this.menu.style.visibility = "visible";
  };
}
