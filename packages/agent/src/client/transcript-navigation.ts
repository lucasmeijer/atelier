interface TranscriptGeometry {
  viewport: number;
  contentHeight: number;
  contentStart: number;
  contentEnd: number;
  bottomPadding: number;
  room: number;
  threshold: number;
  latestTop: number;
}

/** Owns transcript navigation. Geometry is an output of follow intent, never
 * evidence that the user has opted out. In particular, keyboard/viewport resize,
 * scroll anchoring, Turbo updates and programmatic scrolls cannot pause follow. */
export class TranscriptNavigation {
  private following = true;
  private visible = false;
  private frame = 0;
  private hideScrollbarTimer?: ReturnType<typeof setTimeout>;
  private pendingPosition: "prompt" | "instant" | "smooth" | undefined;
  private floor = 0;
  private width = 0;
  private readingAnchor?: { element: HTMLElement; offset: number; height: number };
  private streaming = false;
  private motionFrame = 0;
  private motionTarget = 0;
  private motionTime = 0;
  private motionForward = true;
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private selectionAwaitingSnapshot = false;
  private touch?: { x: number; y: number };
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly transcript: HTMLElement, private readonly content: HTMLElement, private readonly latestButton: HTMLElement, composer: HTMLElement) {
    this.resizeObserver = new ResizeObserver(this.layoutChanged);
    this.resizeObserver.observe(transcript);
    this.resizeObserver.observe(composer);
    this.resizeObserver.observe(content);
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

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.layoutChanged();
    else { this.touch = undefined; this.stopMotion(); }
  }

  select(busy: boolean): void {
    this.hideScrollbar();
    this.setStreaming(busy);
    this.stopMotion();
    this.floor = 0;
    this.readingAnchor = undefined;
    this.transcript.style.removeProperty("--agent-follow-floor");
    this.pendingPosition = busy ? "instant" : "prompt";
    this.selectionAwaitingSnapshot = true;
    this.following = busy;
    this.touch = undefined;
    this.renderMode();
    this.layoutChanged();
  }

  snapshotReady(busy: boolean): void {
    if (this.selectionAwaitingSnapshot) this.select(busy);
    else this.setStreaming(busy);
    this.selectionAwaitingSnapshot = false;
    this.layoutChanged();
  }

  setStreaming(streaming: boolean): void {
    if (this.streaming === streaming) return;
    this.streaming = streaming;
    this.layoutChanged();
  }

  followLatest(): void {
    this.hideScrollbar();
    this.selectionAwaitingSnapshot = false;
    this.touch = undefined;
    this.following = true;
    this.pendingPosition = "smooth";
    this.renderMode();
    this.layoutChanged();
  }

  reveal(target: HTMLElement): void {
    this.pause();
    target.scrollIntoView({ block: "center" });
  }

  private pause(): void {
    this.stopMotion();
    this.pendingPosition = undefined;
    this.selectionAwaitingSnapshot = false;
    this.following = false;
    this.renderMode();
    this.layoutChanged();
  }

  private renderMode(): void {
    this.latestButton.hidden = this.following;
    this.transcript.dataset.following = String(this.following);
  }

  private geometry(): TranscriptGeometry {
    const viewport = this.transcript.clientHeight;
    const contentBounds = this.content.getBoundingClientRect();
    const contentStart = contentBounds.top - this.transcript.getBoundingClientRect().top + this.transcript.scrollTop;
    const bottomPadding = Number.parseFloat(getComputedStyle(this.transcript).paddingBottom);
    const room = this.streaming ? Math.min(160, viewport * 0.25) : bottomPadding;
    const contentEnd = contentStart + contentBounds.height;
    return { viewport, contentHeight: contentBounds.height, contentStart, contentEnd, bottomPadding, room,
      threshold: Math.min(32, room * 0.25), latestTop: Math.max(0, contentEnd - viewport + room) };
  }

  private reserve(geometry: TranscriptGeometry): void {
    // Reserve only streaming headroom and space actually needed by the viewport
    // or a reconciled glide. Never retain a historical content-height maximum.
    // When idle/paused, excess space drains as soon as the reader scrolls back;
    // keeping the current viewport avoids clamping it during a contraction.
    const { viewport, contentStart, contentHeight, bottomPadding, room } = geometry;
    const protectedTop = Math.max(this.transcript.scrollTop, this.motionFrame ? this.motionTarget : 0);
    const floor = Math.ceil(Math.max(0,
      protectedTop + viewport - contentStart - bottomPadding,
      this.streaming && this.following ? contentHeight + room : 0));
    if (floor === this.floor) return;
    this.floor = floor;
    this.transcript.style.setProperty("--agent-follow-floor", `${floor}px`);
  }

  private reconcileMotion(geometry: TranscriptGeometry): void {
    if (!this.motionFrame || this.motionTarget <= geometry.latestTop) return;
    const contentAboveViewport = geometry.contentEnd < this.transcript.scrollTop + geometry.threshold;
    // If the newest content is already visible, stop a forward glide rather than
    // turn a small contraction into backward scrolling. Otherwise shorten/reverse
    // its destination now, not after it has travelled through obsolete reserve.
    const target = this.motionForward && !contentAboveViewport
      ? Math.max(this.transcript.scrollTop, geometry.latestTop)
      : geometry.latestTop;
    if (target === this.transcript.scrollTop) this.stopMotion();
    else this.moveTo(target, false);
  }

  private rememberReadingPosition(): void {
    this.readingAnchor = undefined;
    if (this.following) return;
    const top = this.transcript.getBoundingClientRect().top;
    for (const element of this.content.querySelectorAll<HTMLElement>(".agent-item, p, pre, li, h1, h2, h3, h4, h5, h6")) {
      const bounds = element.getBoundingClientRect();
      if (bounds.height === 0 || bounds.bottom <= top) continue;
      // Prefer the innermost visible block over a potentially very long message.
      if (this.readingAnchor && !this.readingAnchor.element.contains(element)) break;
      this.readingAnchor = { element, offset: bounds.top - top, height: bounds.height };
    }
  }

  readonly layoutChanged = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.visible) return;
      const width = this.transcript.clientWidth;
      const resized = this.width !== 0 && width !== this.width;
      this.width = width;
      const geometry = this.geometry();
      if (resized && !this.pendingPosition) {
        if (this.following) {
          this.pendingPosition = "instant";
        } else if (this.readingAnchor && this.content.contains(this.readingAnchor.element)) {
          const { element, offset, height } = this.readingAnchor;
          const bounds = element.getBoundingClientRect();
          // Scale an offset inside a reflowed block; preserve gaps above it.
          const nextOffset = offset < 0 ? offset * bounds.height / height : offset;
          this.moveTo(this.transcript.scrollTop + bounds.top - this.transcript.getBoundingClientRect().top - nextOffset, true);
        }
      }
      this.reconcileMotion(geometry);
      this.reserve(geometry);

      if (this.pendingPosition === "prompt") {
        this.pendingPosition = undefined;
        const users = this.content.querySelectorAll<HTMLElement>(".agent-user");
        const target = users.item(users.length - 1)?.closest<HTMLElement>(".agent-item");
        this.transcript.scrollTop = target
          ? this.transcript.scrollTop + target.getBoundingClientRect().top - this.transcript.getBoundingClientRect().top
          : 0;
      } else if (!this.following && geometry.contentEnd < this.transcript.scrollTop + geometry.threshold) {
        // A wider pane (for example fullscreen) can reflow the entire transcript
        // above a paused viewport. Do not protect an empty viewport with reserve.
        this.transcript.scrollTop = geometry.latestTop;
      } else if (this.following) {
        // Follow visible content, not scrollHeight (which includes our reserve).
        // Hysteresis lets several new lines use the room before another scroll.
        const plannedTop = this.motionFrame ? Math.max(this.transcript.scrollTop, this.motionTarget) : this.transcript.scrollTop;
        const contentAboveViewport = geometry.contentEnd < this.transcript.scrollTop + geometry.threshold;
        if (this.pendingPosition || contentAboveViewport || geometry.contentEnd > plannedTop + geometry.viewport - geometry.threshold) {
          this.moveTo(geometry.latestTop, this.pendingPosition === "instant");
          this.pendingPosition = undefined;
        }
      }
      this.reserve(geometry);
      this.rememberReadingPosition();
    });
  };

  private moveTo(top: number, instant: boolean): void {
    if (instant || this.reducedMotion.matches) {
      this.stopMotion();
      this.transcript.scrollTop = top;
      return;
    }
    this.motionForward = top >= this.transcript.scrollTop;
    this.motionTarget = top;
    // Retarget an existing glide without restarting it on each incoming delta.
    if (!this.motionFrame) this.motionFrame = requestAnimationFrame(this.glide);
  }

  private readonly glide = (time: number): void => {
    // ResizeObserver reconciliation can be queued behind this animation frame.
    // Re-read geometry before moving so even that frame cannot use a stale goal.
    const geometry = this.geometry();
    this.reconcileMotion(geometry);
    this.reserve(geometry);
    if (!this.motionFrame) return;
    const elapsed = this.motionTime ? Math.min(time - this.motionTime, 64) : 16;
    this.motionTime = time;
    const target = Math.min(this.motionTarget, this.transcript.scrollHeight - this.transcript.clientHeight);
    const distance = target - this.transcript.scrollTop;
    if (this.motionForward && distance < 0) {
      this.stopMotion();
    } else if (this.reducedMotion.matches || Math.abs(distance) <= 2) {
      this.transcript.scrollTop = target;
      this.stopMotion();
    } else {
      this.transcript.scrollTop += distance * (1 - Math.exp(-elapsed / 85));
      this.motionFrame = requestAnimationFrame(this.glide);
    }
    this.reserve(geometry);
  };

  private stopMotion(): void {
    cancelAnimationFrame(this.motionFrame);
    this.motionFrame = 0;
    this.motionTime = 0;
  }

  private readonly hideScrollbar = (): void => {
    clearTimeout(this.hideScrollbarTimer);
    this.transcript.classList.remove("is-scrolling");
  };

  private showScrollbar(): void {
    this.transcript.classList.add("is-scrolling");
    clearTimeout(this.hideScrollbarTimer);
    this.hideScrollbarTimer = setTimeout(this.hideScrollbar, 800);
  }

  private readonly scrolled = (): void => {
    // Only user input reveals the thumb. Keep it visible through native momentum
    // and dragging, but never let automatic follow movement reveal or prolong it.
    if (!this.following && this.transcript.classList.contains("is-scrolling")) this.showScrollbar();
    // Geometry does not toggle intent, and being above the padded end is normal.
    // Paused/idle scrolling must also reclaim reserve behind the viewport.
    if (!this.motionFrame) this.layoutChanged();
  };

  // Conservatively treat upward input anywhere in the transcript as reading,
  // including nested output. Do not try to predict native scroll chaining.
  private readonly wheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.deltaY === 0) return;
    this.showScrollbar();
    if (event.deltaY < 0) this.pause();
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
    this.showScrollbar();
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
    if (up || ["ArrowDown", "PageDown", "End", " "].includes(event.key)) this.showScrollbar();
    if (up) this.pause();
  };

  private readonly pointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if (event.target !== this.transcript && event.target !== this.content && event.target !== this.content.parentElement) return;
    // Both classic and overlay scrollbars belong to the scroll container.
    // Also pause on its bare background: this avoids guessing scrollbar width
    // or tracking a native drag, and leaves ordinary message/control clicks alone.
    this.showScrollbar();
    this.pause();
  };

  disconnect(): void {
    cancelAnimationFrame(this.frame);
    this.stopMotion();
    this.hideScrollbar();
    this.resizeObserver.disconnect();
    this.transcript.style.removeProperty("--agent-follow-floor");
    delete this.transcript.dataset.following;
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
