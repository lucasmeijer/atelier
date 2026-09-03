import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentThinkingController(Controller: StimulusControllerConstructor) {
  return class AgentThinkingController extends Controller {
    static targets = ["content", "preview", "more"];
    declare readonly element: HTMLElement;
    declare readonly contentTarget: HTMLElement;
    declare readonly previewTarget: HTMLElement;
    declare readonly moreTarget: HTMLElement;
    private observer?: MutationObserver;
    private resizeObserver?: ResizeObserver;
    private measureFrame?: number;
    private expanded = false;
    private fullText = "";

    connect(): void {
      this.observer = new MutationObserver(() => this.measure());
      this.observer.observe(this.contentTarget, { childList: true, characterData: true, subtree: true });
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(this.element);
      this.measure();
    }

    disconnect(): void {
      this.observer?.disconnect();
      this.resizeObserver?.disconnect();
      if (this.measureFrame) cancelAnimationFrame(this.measureFrame);
    }

    expand(): void {
      if (!this.element.classList.contains("truncated")) return;
      this.expanded = true;
      this.element.classList.remove("truncated");
      this.element.classList.add("expanded");
      this.contentTarget.hidden = true;
      this.previewTarget.textContent = this.fullText;
      this.previewTarget.hidden = false;
      this.moreTarget.hidden = true;
      this.element.removeAttribute("role");
      this.element.removeAttribute("tabindex");
    }

    keydown(event: KeyboardEvent): void {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.expand();
    }

    private measure(): void {
      if (this.expanded) return;
      if (this.measureFrame) cancelAnimationFrame(this.measureFrame);
      this.measureFrame = requestAnimationFrame(() => {
        this.measureFrame = undefined;
        this.fullText = (this.contentTarget.textContent ?? "").trimEnd();
        this.contentTarget.hidden = true;
        this.previewTarget.textContent = this.fullText;
        this.previewTarget.hidden = false;
        this.moreTarget.hidden = true;
        this.element.classList.remove("truncated");

        const lineHeight = Number.parseFloat(getComputedStyle(this.element).lineHeight);
        const maxHeight = lineHeight * 2;
        if (this.element.scrollHeight <= maxHeight + 1) {
          this.element.removeAttribute("role");
          this.element.removeAttribute("tabindex");
          return;
        }

        this.moreTarget.hidden = false;
        this.element.classList.add("truncated");

        let low = 0;
        let high = this.fullText.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          this.previewTarget.textContent = this.fullText.slice(0, middle).trimEnd();
          if (this.element.scrollHeight <= maxHeight + 1) low = middle;
          else high = middle - 1;
        }
        let preview = this.fullText.slice(0, low).trimEnd();
        // Leave breathing room so the affordance reads as part of the prose,
        // rather than landing against the text's right edge.
        for (let words = 0; words < 4; words++) {
          const wordBoundary = preview.search(/\s+\S+$/);
          if (wordBoundary < 0) break;
          preview = preview.slice(0, wordBoundary).trimEnd();
        }
        this.previewTarget.textContent = preview;
        this.element.setAttribute("role", "button");
        this.element.setAttribute("tabindex", "0");
      });
    }
  };
}

