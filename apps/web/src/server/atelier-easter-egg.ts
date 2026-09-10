import { atelierLogoPathsHtml, Icons } from "@atelier/design-system/icons";

/** The normal mark remains the click target; the clipped scene is decorative. */
export function atelierEasterEggHtml(): string {
  const clipId = `atelier-logo-clip-${crypto.randomUUID()}`;
  return `<span class="atelier-easter-egg" data-controller="atelier-easter-egg" data-action="keydown.esc@window->atelier-easter-egg#reset resize@window->atelier-easter-egg#reset turbo:before-cache@document->atelier-easter-egg#reset">
    <button class="atelier-easter-egg__trigger" type="button" aria-label="Animate Atelier logo" data-action="atelier-easter-egg#play">
      <span class="atelier-easter-egg__rest" data-atelier-easter-egg-target="rest">${Icons.Atelier}</span>
    </button>
    <svg class="atelier-easter-egg__actor" data-atelier-easter-egg-target="actor" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <ellipse class="atelier-easter-egg__portal atelier-easter-egg__portal--bottom" cx="12" cy="31" rx="17" ry="3"/>
      <ellipse class="atelier-easter-egg__portal atelier-easter-egg__portal--top" cx="12" cy="-14" rx="17" ry="3"/>
      <defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><rect x="-20" y="-16" width="64" height="48"/></clipPath></defs>
      <g clip-path="url(#${clipId})">
        <g class="atelier-easter-egg__performer" data-action="animationend->atelier-easter-egg#finish">
          ${atelierLogoPathsHtml}
          <g class="atelier-easter-egg__eyes">
            <ellipse cx="9" cy="10" rx="3.2" ry="4"/>
            <ellipse cx="16" cy="10" rx="3.2" ry="4"/>
            <g class="atelier-easter-egg__pupils"><circle cx="9" cy="10" r="1.2"/><circle cx="16" cy="10" r="1.2"/></g>
          </g>
          <g class="atelier-easter-egg__panic">
            <ellipse class="atelier-easter-egg__mouth" cx="12" cy="18" rx="2.7" ry="4"/>
            <path d="M5 14-2 6-6 3M19 14 26 6 30 3"/>
          </g>
        </g>
      </g>
    </svg>
  </span>`;
}
