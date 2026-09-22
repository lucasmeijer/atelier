import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

let rendererPromise: Promise<typeof import("beautiful-mermaid")["renderMermaidSVG"]> | undefined;

function withoutRemoteFontImports(svg: string): string {
  return svg.replace(/^\s*@import url\([^\n]+\);\s*$/gm, "");
}

export function createAgentMermaidController(Controller: StimulusControllerConstructor) {
  return class AgentMermaidController extends Controller {
    static targets = ["diagram"];
    static values = { source: String };
    declare readonly diagramTarget: HTMLElement;
    declare readonly sourceValue: string;
    private connected = false;
    private activated = false;
    private naturalWidth?: number;
    private observer?: IntersectionObserver;

    connect(): void {
      this.connected = true;
      this.element.addEventListener("turbo:before-morph-element", this.preserveCanvas);
      this.element.addEventListener("turbo:morph-element", this.restoreSize);
      this.observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        this.observer!.disconnect();
        this.activated = true;
        void this.render(this.sourceValue);
      });
      this.observer.observe(this.element);
    }

    disconnect(): void {
      this.connected = false;
      this.activated = false;
      this.observer?.disconnect();
      this.element.removeEventListener("turbo:before-morph-element", this.preserveCanvas);
      this.element.removeEventListener("turbo:morph-element", this.restoreSize);
    }

    sourceValueChanged(): void {
      if (this.activated) void this.render(this.sourceValue);
    }

    // Only the generated canvas is browser-owned. The source value must still
    // morph, so edited diagrams render again without reconnecting the controller.
    private readonly preserveCanvas = (event: Event): void => {
      if (event.target === this.diagramTarget) event.preventDefault();
    };

    private readonly restoreSize = (): void => {
      if (this.naturalWidth === undefined) return;
      this.diagramTarget.style.setProperty("--agent-mermaid-natural-width", `${this.naturalWidth}px`);
      this.element.closest<HTMLElement>(".agent-mermaid")?.style.setProperty("--agent-mermaid-card-width", `${Math.max(280, this.naturalWidth)}px`);
    };

    private async render(source: string): Promise<void> {
      try {
        const renderMermaidSVG = await (rendererPromise ??= import("beautiful-mermaid").then(module => module.renderMermaidSVG));
        const svgHtml = withoutRemoteFontImports(renderMermaidSVG(source, {
          bg: "var(--atelier-mermaid-bg)",
          fg: "var(--atelier-mermaid-fg)",
          line: "var(--atelier-mermaid-line)",
          accent: "var(--atelier-mermaid-accent)",
          muted: "var(--atelier-mermaid-muted)",
          surface: "var(--atelier-mermaid-surface)",
          border: "var(--atelier-mermaid-border)",
          padding: 16,
          transparent: true,
        }));
        if (!this.connected || source !== this.sourceValue) return;
        this.diagramTarget.innerHTML = svgHtml;
        const svg = this.diagramTarget.querySelector<SVGSVGElement>("svg")!;
        this.naturalWidth = Math.ceil(svg.viewBox.baseVal.width);
        this.restoreSize();
        this.diagramTarget.setAttribute("aria-busy", "false");
      } catch (error) {
        if (!this.connected || source !== this.sourceValue) return;
        const message = document.createElement("pre");
        message.className = "agent-mermaid-error";
        message.textContent = error instanceof Error ? error.message : String(error);
        this.diagramTarget.replaceChildren(message);
        this.diagramTarget.setAttribute("aria-busy", "false");
      }
    }
  };
}
