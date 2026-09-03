import { workspaceProxyUrl, type WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentProxyController(Controller: StimulusControllerConstructor) {
  return class AgentProxyController extends Controller {
    static values = { workspaceId: String, appKey: String, path: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly appKeyValue: string;
    declare readonly pathValue: string;

    connect(): void {
      const url = workspaceProxyUrl(this.workspaceIdValue, this.appKeyValue, this.pathValue || "/");
      if (this.element instanceof HTMLAnchorElement) this.element.href = url;
      else if (this.element instanceof HTMLImageElement || this.element instanceof HTMLVideoElement || this.element instanceof HTMLIFrameElement) this.element.src = url;
    }
  };
}

