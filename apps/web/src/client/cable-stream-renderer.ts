// @ts-expect-error Turbo ships no TypeScript declarations.
import { StreamActions } from "@hotwired/turbo";
import type { CableStreamRenderer } from "./cable.ts";

type Stream = HTMLElement & { targetElements: HTMLElement[]; templateContent: DocumentFragment };
let delivery = Promise.resolve();

/** One application queue, not just a receipt-time lease check. Parent mounts and
 * their children are applied in wire order, with no deferred Turbo repaint race. */
export const renderCableStreams: CableStreamRenderer = (html, isCurrent, onApplied) => {
  delivery = delivery.then(async () => {
    if (!isCurrent()) return;
    const template = document.createElement("template");
    template.innerHTML = html;
    const fragment = document.importNode(template.content, true);
    customElements.upgrade(fragment);
    for (const stream of fragment.querySelectorAll<Stream>("turbo-stream")) {
      if (!isCurrent()) return;
      // Permanent islands survive only while their key remains in the parent's
      // snapshot. Turbo itself preserves them even when absent, so dispose those
      // absent keys explicitly before morphing the owning region.
      if (stream.getAttribute("method") === "morph") {
        for (const target of stream.targetElements) {
          const islands = [...target.querySelectorAll<HTMLElement>("[id][data-turbo-permanent]")];
          for (const island of islands) {
            if (islands.some(parent => parent !== island && parent.contains(island))) continue;
            if (!stream.templateContent.querySelector(`#${CSS.escape(island.id)}`)) island.remove();
          }
        }
      }
      const action = StreamActions[stream.getAttribute("action")!];
      if (!action) throw new Error(`Unknown live action: ${stream.getAttribute("action")}`);
      await action.call(stream);
    }
    if (!isCurrent()) return;
    document.querySelectorAll("[data-controller~='workspace-presentation']").forEach(element => element.dispatchEvent(new Event("live:structure")));
    document.dispatchEvent(new Event("atelier:workspace-pane-changed"));
    onApplied();
  }).catch(error => {
    // A failed application cannot be treated as current. Report it and force a
    // new snapshot rather than continuing from a partially applied delta stream.
    console.error("Live presentation could not be applied", error);
    window.AtelierCable?.reconnect();
  });
};
