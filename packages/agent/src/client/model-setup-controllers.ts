import type { WorkspaceClientControllerConstructor } from "@atelier/shared";

export function createLaunchModelRefreshController(Controller: WorkspaceClientControllerConstructor) {
  return class LaunchModelRefreshController extends Controller {
    declare readonly element: HTMLElement;
    connect(): void {
      const frame = this.element.closest<HTMLElement & { reload(): void }>("turbo-frame")!;
      const model = frame.querySelector<HTMLInputElement>('input[name="model"]')!.value;
      const level = frame.querySelector<HTMLSelectElement>('select[name="level"]')?.value;
      const url = new URL("/launch-composer/settings", window.location.href);
      if (model) url.searchParams.set("model", model);
      if (level) url.searchParams.set("level", level);
      const source = url.pathname + url.search;
      if (frame.getAttribute("src") === source) frame.reload();
      else frame.setAttribute("src", source);
      this.element.remove();
    }
  };
}
export function createAgentModelSetupController(Controller: WorkspaceClientControllerConstructor) {
  return class AgentModelSetupController extends Controller {
    declare readonly element: HTMLElement;
    guard(event: Event): void {
      if (this.element.querySelector('[data-model-ready="false"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.open(event);
      }
    }

    async open(event: Event): Promise<void> {
      event.preventDefault();
      const controlledMenuId = this.element.getAttribute("aria-controls");
      const menu = this.element.closest<HTMLElement>(".popup-menu[popover]") ?? (controlledMenuId ? document.getElementById(controlledMenuId) : null);
      if (menu?.matches(":popover-open")) menu.hidePopover();
      const response = await fetch("/settings/models/dialog", { headers: { Accept: "text/vnd.turbo-stream.html" } });
      window.Turbo!.renderStreamMessage(await response.text());
    }
  };
}
