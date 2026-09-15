import { Application, Controller } from "@hotwired/stimulus";
class ProgressController extends Controller<HTMLElement> {
  static values = { events: String, return: Boolean };
  declare eventsValue: string;
  declare returnValue: boolean;
  source?: EventSource;
  connect() {
    this.source = new EventSource(this.eventsValue);
    this.source.addEventListener("progress", (event) => {
      const template = document.createElement("template");
      // SAFETY: EventSource dispatches server-sent events as MessageEvent instances.
      template.innerHTML = (event as MessageEvent<string>).data;
      this.element
        .querySelector("[data-progress-content]")!
        .replaceChildren(template.content);
    });
    this.source.addEventListener("ready", () => {
      if (this.returnValue) window.location.replace("/");
    });
  }
  disconnect() {
    this.source?.close();
  }
}
Application.start().register("progress", ProgressController);
