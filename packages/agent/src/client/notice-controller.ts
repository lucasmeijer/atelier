import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentNoticeController(Controller: StimulusControllerConstructor) {
  return class AgentNoticeController extends Controller {
    static values = { autoDismiss: { type: Boolean, default: true } };
    declare readonly autoDismissValue: boolean;
    declare readonly element: HTMLElement;
    private timer?: ReturnType<typeof setTimeout>;

    connect(): void {
      if (this.autoDismissValue) this.timer = setTimeout(() => this.dismiss(), 8000);
    }

    dismiss(): void {
      this.element.remove();
    }

    disconnect(): void {
      if (this.timer) clearTimeout(this.timer);
    }
  };
}
