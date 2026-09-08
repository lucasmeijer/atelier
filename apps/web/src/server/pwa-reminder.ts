import { activityButtonHtml } from "@atelier/design-system/activity-button";
import { buttonHtml } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { dialogHtml } from "@atelier/design-system/dialog";
import { Icons } from "@atelier/design-system/icons";
import { escapeHtml } from "@atelier/shared";

// Menu paths checked against the linked vendor documentation on 2026-09-08.
const guides = [
  {
    id: "ios",
    menu: "… → Share ↑",
    item: "＋ Add to Home Screen",
    source: "https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios",
    steps: [
      "Tap … → Share (or Share directly in the Top/Bottom tab layout).",
      "Choose Add to Home Screen. Turn on Open as Web App, then tap Add.",
      "Missing the option? Find it under Edit Actions in the Share menu.",
    ],
  },
  {
    id: "ipad",
    menu: "Share ↑ → …",
    item: "＋ Add to Home Screen",
    source: "https://support.apple.com/guide/ipad/open-as-web-app-ipad8f1f7a29/ipados",
    steps: [
      "Tap Share → … → Add to Home Screen.",
      "Turn on Open as Web App, then tap Add.",
    ],
  },
  {
    id: "android",
    menu: "⋮ → Install and create shortcut",
    item: "Install",
    source: "https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid",
    steps: [
      "Tap ⋮ → Install and create shortcut → Install.",
      "Follow the prompts, then open Atelier from your apps.",
    ],
  },
  {
    id: "mac",
    menu: "File",
    item: "Add to Dock…",
    source: "https://support.apple.com/en-us/104996",
    steps: [
      "Choose File → Add to Dock → Add.",
      "Open Atelier from the Dock. Requires macOS Sonoma 14 or newer.",
    ],
  },
  {
    id: "edge",
    menu: "… → More tools → Apps",
    item: "Install this site as an app",
    source: "https://support.microsoft.com/en-us/microsoft-edge/install-manage-or-uninstall-apps-in-microsoft-edge-0c156575-a94a-45e4-a54f-3a84846f6113",
    steps: [
      "Choose … → More tools → Apps → Install this site as an app.",
      "Confirm installation. Find installed apps at edge://apps.",
    ],
  },
  {
    id: "chrome",
    menu: "⋮ → Cast, save, and share",
    item: "Install page as app…",
    source: "https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DDesktop",
    steps: [
      "Choose ⋮ → Cast, save, and share → Install page as app…",
      "Follow the prompts, then open Atelier from your apps.",
    ],
  },
  {
    id: "other",
    menu: "Supported browser",
    item: "Open Atelier → Install",
    steps: [
      "For the verified steps, open this address in Chrome or Edge on desktop, Chrome on Android, or Safari on iPhone/iPad.",
      "Use the browser’s Install app option (Safari: Share → Add to Home Screen).",
    ],
  },
];

function menuPathHtml(menu: string, item: string): string {
  return `<figure class="pwa-reminder-guide"><svg viewBox="0 0 440 124" aria-hidden="true"><text x="18" y="31" fill="currentColor" font-size="14">${escapeHtml(menu)}</text><path d="M28 44v30h20m-6-6 6 6-6 6" fill="none" stroke="currentColor"/><text x="74" y="80" fill="currentColor" font-size="15">${escapeHtml(item)}</text></svg></figure>`;
}

export function renderPwaReminder(): string {
  const button = activityButtonHtml({
    variant: "secondary",
    state: "initial",
    iconOnly: true,
    initialLabel: "Install Atelier as an app",
    activeLabel: "Install Atelier as an app",
    initialContent: { kind: "html", html: Icons.Exclamation },
    activeContent: { kind: "html", html: Icons.Exclamation },
    attributesHtml: 'data-pwa-reminder-target="button" data-action="click->pwa-reminder#open"',
  });
  const footer = `<form method="dialog">${buttonGroupHtml({
    orientation: "horizontal",
    semantics: "layout",
    itemsHtml: buttonHtml({
      type: "submit",
      variant: "secondary",
      content: { kind: "caption", caption: "Stop bugging me, maybe later" },
      attributesHtml: 'data-action="click->pwa-reminder#quiet"',
    }) + buttonHtml({
      type: "submit",
      variant: "primary",
      content: { kind: "caption", caption: "OK" },
    }),
  })}</form>`;
  const body = guides.map(guide => `<section data-pwa-reminder-target="guide" data-platform="${guide.id}" hidden>
    ${menuPathHtml(guide.menu, guide.item)}
    <ol>${guide.steps.map(step => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
    ${guide.source ? `<p><a href="${escapeHtml(guide.source)}" target="_blank" rel="noopener noreferrer">Official instructions ↗</a></p>` : ""}
  </section>`).join("");
  const dialog = dialogHtml({
    element: { attributesHtml: 'data-pwa-reminder-target="dialog"' },
    iconHtml: Icons.Atelier,
    titleCaption: "Atelier works better as an app",
    bodyHtml: `<div class="pwa-reminder-body"><p>Install Atelier as a PWA for a dedicated window and quick access.</p>${body}</div>`,
    footerHtml: footer,
  });
  return `<div data-controller="pwa-reminder" data-action="storage@window->pwa-reminder#refresh focus@window->pwa-reminder#refresh" hidden>${button}${dialog}</div>`;
}
