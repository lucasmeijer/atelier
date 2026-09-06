import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentThinkingController(Controller: StimulusControllerConstructor) {
  return class AgentThinkingController extends Controller {
    static targets = ["content", "preview", "more"];
    declare readonly element: HTMLElement;
    declare readonly contentTarget: HTMLElement;
    declare readonly previewTarget: HTMLElement;
    declare readonly moreTarget: HTMLElement;
    private observer?: MutationObserver;
    private renderFrame?: number;
    private expanded = false;

    connect(): void {
      this.observer = new MutationObserver(() => this.renderPreview());
      this.observer.observe(this.contentTarget, { childList: true, characterData: true, subtree: true });
      this.renderPreview();
    }

    disconnect(): void {
      this.observer?.disconnect();
      if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
    }

    expand(): void {
      if (!this.element.classList.contains("truncated")) return;
      this.expanded = true;
      if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
      this.element.classList.remove("truncated");
      this.element.classList.add("expanded");
      this.contentTarget.hidden = false;
      this.previewTarget.hidden = true;
      this.moreTarget.hidden = true;
      this.element.removeAttribute("role");
      this.element.removeAttribute("tabindex");
    }

    keydown(event: KeyboardEvent): void {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.expand();
    }

    private renderPreview(): void {
      if (this.expanded) return;
      if (this.renderFrame) cancelAnimationFrame(this.renderFrame);
      this.renderFrame = requestAnimationFrame(() => {
        this.renderFrame = undefined;
        const fullText = (this.contentTarget.textContent ?? "").trimEnd();
        this.contentTarget.hidden = true;
        this.previewTarget.textContent = fullText;
        this.previewTarget.hidden = false;
        this.moreTarget.hidden = true;
        this.element.classList.remove("truncated");

        const words = fullText.matchAll(/\S+/g);
        let cutoff: number | undefined;
        let count = 0;
        for (const word of words) {
          if (++count === 101) {
            cutoff = word.index;
            break;
          }
        }
        if (cutoff === undefined) {
          this.element.removeAttribute("role");
          this.element.removeAttribute("tabindex");
          return;
        }

        this.moreTarget.hidden = false;
        this.element.classList.add("truncated");

        this.previewTarget.textContent = fullText.slice(0, cutoff).trimEnd();
        this.element.setAttribute("role", "button");
        this.element.setAttribute("tabindex", "0");
      });
    }
  };
}

