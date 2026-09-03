import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentNoticeController(Controller: StimulusControllerConstructor) {
  return class AgentNoticeController extends Controller {
    declare readonly element: HTMLElement;
    private timer?: ReturnType<typeof setTimeout>;

    connect(): void {
      this.timer = setTimeout(() => this.element.remove(), 8000);
    }

    disconnect(): void {
      if (this.timer) clearTimeout(this.timer);
    }
  };
}
