import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

const rendererPromise = import("beautiful-mermaid").then(({ renderMermaidSVG }) => renderMermaidSVG);

function withoutRemoteFontImports(svg: string): string {
  return svg.replace(/^\s*@import url\([^\n]+\);\s*$/gm, "");
}

export function createAgentMermaidController(Controller: StimulusControllerConstructor) {
  return class AgentMermaidController extends Controller {
    static targets = ["diagram", "source"];
    declare readonly diagramTarget: HTMLElement;
    declare readonly sourceTarget: HTMLElement;
    private connected = false;

    connect(): void {
      this.connected = true;
      void this.render(this.sourceTarget.textContent ?? "");
    }

    disconnect(): void {
      this.connected = false;
    }

    private async render(source: string): Promise<void> {
      try {
        const renderMermaidSVG = await rendererPromise;
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
        if (!this.connected) return;
        this.diagramTarget.innerHTML = svgHtml;
        const svg = this.diagramTarget.querySelector<SVGSVGElement>("svg")!;
        const naturalWidth = Math.ceil(svg.viewBox.baseVal.width);
        this.diagramTarget.style.setProperty("--agent-mermaid-natural-width", `${naturalWidth}px`);
        this.element.closest<HTMLElement>(".agent-mermaid")?.style.setProperty("--agent-mermaid-card-width", `${Math.max(280, naturalWidth)}px`);
        this.diagramTarget.setAttribute("aria-busy", "false");
      } catch (error) {
        if (!this.connected) return;
        const message = document.createElement("pre");
        message.className = "agent-mermaid-error";
        message.textContent = error instanceof Error ? error.message : String(error);
        this.diagramTarget.replaceChildren(message);
        this.diagramTarget.setAttribute("aria-busy", "false");
      }
    }
  };
}
