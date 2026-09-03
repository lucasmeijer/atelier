import { Controller } from "@hotwired/stimulus";
import { atelierCableConnectionHeader, CableTopics } from "@atelier/shared";
import { registerWorkspaceControllers } from "./workspace-controller-registry.ts";
import { createAtelierCableClient } from "./cable.ts";

export function cableRequestHeaders(initial: HeadersInit = {}): Headers {
  const headers = new Headers(initial);
  const connectionId = window.AtelierCable?.connectionId();
  if (connectionId) headers.set(atelierCableConnectionHeader, connectionId);
  return headers;
}

class CableShellController extends Controller {
  connect(): void {
    window.AtelierCable?.subscribe(CableTopics.shell());
  }
}

export function installWorkspaceCable(): void {
  window.AtelierCable ??= createAtelierCableClient();
  document.addEventListener("turbo:before-fetch-request", (event) => {
    // SAFETY: Turbo is the sole producer of this event and provides mutable fetch options.
    const detail = (event as CustomEvent<{ fetchOptions: RequestInit }>).detail;
    detail.fetchOptions.headers = cableRequestHeaders(detail.fetchOptions.headers);
  });
  registerWorkspaceControllers({ "cable-shell": CableShellController });
}
