import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

const htmlPreviewBaselineHeight = 420;
const htmlPreviewResourceGraceMs = 2_000;
const htmlPreviewResourceDebounceMs = 100;

type HtmlPreviewFrame = { style: { height: string } };
type HtmlPreviewDocument = { body: Pick<HTMLElement, "scrollHeight">; documentElement: Pick<HTMLElement, "scrollHeight"> };

export function fitHtmlPreview(frame: HtmlPreviewFrame, doc: HtmlPreviewDocument): void {
  frame.style.height = `${htmlPreviewBaselineHeight}px`;
  frame.style.height = `${Math.max(htmlPreviewBaselineHeight, doc.documentElement.scrollHeight, doc.body.scrollHeight)}px`;
}

export function createAgentHtmlPreviewController(Controller: StimulusControllerConstructor) {
  return class AgentHtmlPreviewController extends Controller {
    declare readonly element: HTMLIFrameElement;
    private document?: Document;
    private resourceGraceTimer?: ReturnType<typeof setTimeout>;
    private resourceFitTimer?: ReturnType<typeof setTimeout>;
    private readonly loaded = (): void => this.attach();
    private readonly resourceLoaded = (event: Event): void => {
      const view = this.document?.defaultView;
      if (!view || !(event.target instanceof view.HTMLImageElement)) return;
      clearTimeout(this.resourceFitTimer);
      this.resourceFitTimer = setTimeout(() => this.fit(), htmlPreviewResourceDebounceMs);
    };

    connect(): void {
      this.element.addEventListener("load", this.loaded);
      if (this.element.contentDocument?.readyState === "complete") this.attach();
    }

    disconnect(): void {
      this.element.removeEventListener("load", this.loaded);
      this.detach();
    }

    private detach(): void {
      this.document?.removeEventListener("load", this.resourceLoaded, true);
      clearTimeout(this.resourceGraceTimer);
      clearTimeout(this.resourceFitTimer);
      this.document = undefined;
    }

    private fit(): void {
      if (this.document) fitHtmlPreview(this.element, this.document);
    }

    private attach(): void {
      this.detach();
      const doc = this.element.contentDocument!;
      this.document = doc;
      doc.addEventListener("load", this.resourceLoaded, true);
      this.resourceGraceTimer = setTimeout(() => doc.removeEventListener("load", this.resourceLoaded, true), htmlPreviewResourceGraceMs);
      this.fit();
      void doc.fonts.ready.then(() => {
        if (this.document === doc) this.fit();
      });
    }
  };
}

