// Turbo does not publish TypeScript declarations.
// @ts-expect-error No declaration file is included in @hotwired/turbo.
import { renderStreamMessage } from "@hotwired/turbo";
import type { CableStreamRenderer } from "./cable.ts";

/** Decorate server-rendered streams with the subscription lease that owns them.
 * Turbo defers actions until the next repaint, so checking only at receipt lets
 * a collapsed or superseded subscription mutate a newly opened transcript. */
export const renderCableStreams: CableStreamRenderer = (html, isCurrent, onApplied) => {
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = document.importNode(template.content, true);
  const streams = [...fragment.querySelectorAll("turbo-stream")];
  let remaining = streams.length;
  if (remaining === 0) {
    onApplied();
    return;
  }
  for (const stream of streams) {
    stream.addEventListener("turbo:before-stream-render", (event) => {
      // SAFETY: Turbo owns this event and exposes its awaited action callback.
      const detail = (event as CustomEvent<{ render(element: HTMLElement): Promise<void> }>).detail;
      const render = detail.render;
      detail.render = async (element) => {
        if (isCurrent()) await render(element);
        if (--remaining === 0) onApplied();
      };
    }, { once: true });
  }
  // Turbo accepts a StreamMessage-like object; using its fragment preserves
  // the per-element behavior above without re-parsing or generating UI markup.
  renderStreamMessage({ fragment });
};
