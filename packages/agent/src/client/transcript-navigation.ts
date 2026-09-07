/** Owns transcript navigation. Geometry is an output of follow intent, never
 * evidence that the user has opted out. In particular, keyboard/viewport resize,
 * scroll anchoring, Turbo updates and programmatic scrolls cannot pause follow. */
export class TranscriptNavigation {
  private following = true;
  private visible = false;
  private frame = 0;
  private hideScrollbarTimer?: ReturnType<typeof setTimeout>;
  private selectionPending = false;
  private selectionAwaitingSnapshot = false;
  private touch?: { x: number; y: number };
  private readonly resizeObserver: ResizeObserver;
  private readonly mutationObserver: MutationObserver;
  private readonly observedItems = new Set<Element>();

  constructor(private readonly transcript: HTMLElement, private readonly latestButton: HTMLElement, composer: HTMLElement) {
    this.resizeObserver = new ResizeObserver(this.layoutChanged);
    this.resizeObserver.observe(transcript);
    this.resizeObserver.observe(composer);
    this.mutationObserver = new MutationObserver(() => {
      this.observeItems();
      this.layoutChanged();
    });
    this.mutationObserver.observe(transcript, { childList: true, subtree: true, characterData: true });
    this.observeItems();
    transcript.addEventListener("scroll", this.scrolled);
    transcript.addEventListener("wheel", this.wheel, { capture: true, passive: true });
    transcript.addEventListener("touchstart", this.touchStarted, { passive: true });
    transcript.addEventListener("touchmove", this.touchMoved, { passive: true });
    transcript.addEventListener("touchend", this.touchEnded, { passive: true });
    transcript.addEventListener("touchcancel", this.touchEnded, { passive: true });
    transcript.addEventListener("keydown", this.keydown);
    transcript.addEventListener("pointerdown", this.pointerDown);
    window.visualViewport?.addEventListener("resize", this.layoutChanged);
    this.renderMode();
  }

  private observeItems(): void {
    for (const item of this.observedItems) {
      if (item.parentElement === this.transcript) continue;
      this.resizeObserver.unobserve(item);
      this.observedItems.delete(item);
    }
    for (const item of this.transcript.children) {
      if (this.observedItems.has(item)) continue;
      this.observedItems.add(item);
      this.resizeObserver.observe(item);
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.layoutChanged();
    else this.touch = undefined;
  }

  select(busy: boolean): void {
    this.selectionAwaitingSnapshot = true;
    this.following = busy;
    this.selectionPending = !busy;
    this.touch = undefined;
    this.renderMode();
    this.layoutChanged();
  }

  snapshotReady(busy: boolean): void {
    if (this.selectionAwaitingSnapshot) this.select(busy);
    this.selectionAwaitingSnapshot = false;
    this.layoutChanged();
  }

  followLatest(): void {
    this.selectionAwaitingSnapshot = false;
    this.selectionPending = false;
    this.touch = undefined;
    this.following = true;
    this.renderMode();
    this.layoutChanged();
  }

  reveal(target: HTMLElement): void {
    this.pause();
    target.scrollIntoView({ block: "center" });
  }

  private pause(): void {
    this.selectionAwaitingSnapshot = false;
    this.following = false;
    this.selectionPending = false;
    this.renderMode();
  }

  private renderMode(): void {
    this.latestButton.hidden = this.following;
  }

  private atEnd(): boolean {
    return this.transcript.scrollTop >= this.transcript.scrollHeight - this.transcript.clientHeight - 1;
  }

  readonly layoutChanged = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.visible) return;
      if (this.selectionPending) {
        this.selectionPending = false;
        const users = this.transcript.querySelectorAll<HTMLElement>(".agent-user");
        const target = users.item(users.length - 1)?.closest<HTMLElement>(".agent-item");
        this.transcript.scrollTop = target
          ? this.transcript.scrollTop + target.getBoundingClientRect().top - this.transcript.getBoundingClientRect().top
          : 0;
      } else if (this.following) {
        this.transcript.scrollTop = this.transcript.scrollHeight;
      }
    });
  };

  private readonly scrolled = (): void => {
    this.transcript.classList.add("is-scrolling");
    clearTimeout(this.hideScrollbarTimer);
    this.hideScrollbarTimer = setTimeout(() => this.transcript.classList.remove("is-scrolling"), 800);
    // A layout-driven scroll may run after ResizeObserver's reconciliation.
    // Reassert intent rather than classifying the movement as user navigation.
    if (this.following && !this.atEnd()) this.layoutChanged();
  };

  // Conservatively treat upward input anywhere in the transcript as reading,
  // including nested output. Do not try to predict native scroll chaining.
  private readonly wheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && event.deltaY < 0) this.pause();
  };

  private readonly touchStarted = (event: TouchEvent): void => {
    this.touch = event.touches.length === 1 ? { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY } : undefined;
  };

  private readonly touchMoved = (event: TouchEvent): void => {
    if (!this.touch || event.touches.length !== 1) { this.touch = undefined; return; }
    const point = event.touches[0]!;
    const delta = this.touch.y - point.clientY;
    if (Math.abs(delta) < 4 || Math.abs(delta) < Math.abs(this.touch.x - point.clientX)) return;
    this.touch = { x: point.clientX, y: point.clientY };
    if (delta < 0) this.pause();
  };

  private readonly touchEnded = (): void => { this.touch = undefined; };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.metaKey) return;
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || target.closest("input, textarea, select")) return;
      // Space activates these controls; Page Up/Home/arrows still scroll.
      if (event.key === " " && target.closest("button, summary")) return;
    }
    const up = ["ArrowUp", "PageUp", "Home"].includes(event.key)
      || (event.key === " " && event.shiftKey);
    if (up) this.pause();
  };

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || event.button !== 0 || event.target !== this.transcript) return;
    // Both classic and overlay scrollbars belong to the scroll container.
    // Also pause on its bare background: this avoids guessing scrollbar width
    // or tracking a native drag, and leaves ordinary message/control clicks alone.
    this.pause();
  };

  disconnect(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.hideScrollbarTimer);
    this.resizeObserver.disconnect();
    this.mutationObserver.disconnect();
    this.observedItems.clear();
    this.transcript.classList.remove("is-scrolling");
    this.transcript.removeEventListener("scroll", this.scrolled);
    this.transcript.removeEventListener("wheel", this.wheel, true);
    this.transcript.removeEventListener("touchstart", this.touchStarted);
    this.transcript.removeEventListener("touchmove", this.touchMoved);
    this.transcript.removeEventListener("touchend", this.touchEnded);
    this.transcript.removeEventListener("touchcancel", this.touchEnded);
    this.transcript.removeEventListener("keydown", this.keydown);
    this.transcript.removeEventListener("pointerdown", this.pointerDown);
    window.visualViewport?.removeEventListener("resize", this.layoutChanged);
  }
}
