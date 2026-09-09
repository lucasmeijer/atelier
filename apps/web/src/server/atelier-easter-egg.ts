import { Icons } from "@atelier/design-system/icons";

/** Keep the canonical logo at rest; the articulated double only appears during its excursion. */
export function atelierEasterEggHtml(): string {
  return `<span class="atelier-easter-egg" data-controller="atelier-easter-egg" data-action="keydown.esc@window->atelier-easter-egg#reset resize@window->atelier-easter-egg#reset turbo:before-cache@document->atelier-easter-egg#reset">
    <button class="atelier-easter-egg__trigger" type="button" aria-label="Animate Atelier logo" data-action="atelier-easter-egg#play">
      <span class="atelier-easter-egg__rest" data-atelier-easter-egg-target="rest">${Icons.Atelier}</span>
    </button>
    <span class="atelier-easter-egg__actor" data-atelier-easter-egg-target="actor" aria-hidden="true">
      <span class="atelier-easter-egg__traveler" data-action="animationend->atelier-easter-egg#finish">
        <svg class="atelier-easter-egg__performer" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v4"/>
          <path class="atelier-easter-egg__leg atelier-easter-egg__leg--left" d="M7.5 21 12 7"/>
          <path class="atelier-easter-egg__leg atelier-easter-egg__leg--right" d="m12 7 4.5 14"/>
          <path d="M6 18h12"/>
          <path class="atelier-easter-egg__arms" d="M4 13c4 1.5 7.5 1.8 11 .8 2-.6 3.7-.6 5-.2"/>
          <g class="atelier-easter-egg__eyes" stroke-width="1.8"><path d="M10.5 10h.01M13.5 10h.01"/></g>
        </svg>
      </span>
    </span>
  </span>`;
}
