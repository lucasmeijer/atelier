import { CableTopics, type CableSubscription } from "@atelier/shared";
import { Controller } from "@hotwired/stimulus";
import { renderCableStreams } from "./cable-stream-renderer.ts";
import { createAtelierCableClient } from "./cable.ts";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";

class CableShellController extends Controller<HTMLElement> {
  private subscription?: CableSubscription;
  connect(): void {
    document.addEventListener("live:connection", this.changed);
    document.addEventListener("submit", this.guard, true);
    document.addEventListener("turbo:before-morph-attribute", this.preserveDisclosure);
    this.subscription = window.AtelierCable!.subscribe(CableTopics.shell());
    this.changed();
  }
  disconnect(): void {
    this.subscription?.unsubscribe();
    document.removeEventListener("live:connection", this.changed);
    document.removeEventListener("submit", this.guard, true);
    document.removeEventListener("turbo:before-morph-attribute", this.preserveDisclosure);
  }
  private readonly changed = (): void => {
    const ready = window.AtelierCable!.ready();
    this.element.dataset.liveReady = String(ready);
    const status = document.getElementById("live-connection-status");
    if (status) status.hidden = ready;
  };
  private readonly guard = (event: Event): void => {
    if (!window.AtelierCable!.ready()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  private readonly preserveDisclosure = (event: Event): void => {
    // SAFETY: Turbo emits this event with its attribute mutation descriptor.
    const detail = (event as CustomEvent<{ attributeName: string }>).detail;
    if (event.target instanceof HTMLDetailsElement && detail.attributeName === "open") event.preventDefault();
  };
}
export function installWorkspaceCable(): void {
  window.AtelierCable ??= createAtelierCableClient(renderCableStreams);
  registerWorkspaceControllers({ "cable-shell": CableShellController });
}
