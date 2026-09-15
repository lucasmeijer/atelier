import { Controller } from "@hotwired/stimulus";

/** System events invalidate a server-rendered Turbo frame; no client-side markup. */
export class AccessSettingsController extends Controller<HTMLElement & { reload(): void }> {
  source?: EventSource;
  connect() {
    this.source = new EventSource("/settings/access/events");
    this.source.addEventListener("access", () => this.element.reload());
  }
  disconnect() { this.source?.close(); }
}
