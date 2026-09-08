import { Controller } from "@hotwired/stimulus";
import { atelierCableConnectionHeader, CableTopics, type CableSubscription } from "@atelier/shared";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";
import { createAtelierCableClient } from "./cable.ts";
import { renderCableStreams } from "./cable-stream-renderer.ts";

export function cableRequestHeaders(initial: HeadersInit = {}): Headers {
  const headers = new Headers(initial);
  const connectionId = window.AtelierCable?.connectionId();
  if (connectionId) headers.set(atelierCableConnectionHeader, connectionId);
  return headers;
}

class CableShellController extends Controller {
  private cableSubscription?: CableSubscription;

  connect(): void {
    this.cableSubscription = window.AtelierCable?.subscribe(CableTopics.shell());
  }

  disconnect(): void {
    this.cableSubscription?.unsubscribe();
    this.cableSubscription = undefined;
  }
}

export function installWorkspaceCable(): void {
  window.AtelierCable ??= createAtelierCableClient(renderCableStreams);
  document.addEventListener("turbo:before-fetch-request", (event) => {
    // SAFETY: Turbo is the sole producer of this event and provides mutable fetch options.
    const detail = (event as CustomEvent<{ fetchOptions: RequestInit }>).detail;
    detail.fetchOptions.headers = cableRequestHeaders(detail.fetchOptions.headers);
  });
  registerWorkspaceControllers({ "cable-shell": CableShellController });
}
