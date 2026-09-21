import { Icons } from "@atelier/design-system/icons";
import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { domId, escapeHtml, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { isWorkspaceLoopbackHost } from "../shared.ts";
import { browserFrameId, type WorkspaceBrowserView } from "./state.ts";

export function browserWorkViewPresentation(view: WorkspaceBrowserView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: view.key,
    label: view.label,
    reference: { type: "browser", browserId: view.key },
    kind: "resource", iconHtml: Icons.Browser,
    availability: { phase: "live" },
  };
}

export function renderBrowserWorkViewBody(workspaceId: string, view: WorkspaceBrowserView, previewUrl: string): string {
  return `<section class="work-view-pane" data-work-view-source="${escapeHtml(view.key)}"><div class="browser-pane">${renderBrowserFrame(workspaceId, view, previewUrl)}</div></section>`;
}

const workspacePreviewPermissions = [
  "clipboard-write",
  "camera",
  "microphone",
  "geolocation",
  "display-capture",
  "fullscreen",
  "autoplay",
  "picture-in-picture",
  "web-share",
  "payment",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "midi",
  "gamepad",
  "accelerometer",
  "gyroscope",
  "magnetometer",
  "xr-spatial-tracking",
].map((feature) => `${feature} *`).join("; ");

export function renderBrowserFrame(workspaceId: string, view: WorkspaceBrowserView, previewUrl: string): string {
  const navigationKey = domId("browser_navigation", workspaceId, view.key, Bun.hash(previewUrl).toString(16));
  const target = view.targetUrl ? new URL(view.targetUrl) : undefined;
  const appKey = view.key;
  const frameControllerAttributes = previewUrl
    ? ` src="${escapeHtml(previewUrl)}"${target && isWorkspaceLoopbackHost(target.hostname) ? ` allow="${workspacePreviewPermissions}" allowfullscreen` : ""}`
    : "";
  const externalLinkContent = {
    kind: "icon-only" as const,
    iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6"/></svg>',
    label: "Open preview in a new view",
  };
  const externalLink = target
    ? actionLinkHtml({
      href: previewUrl,
      variant: "secondary",
      content: externalLinkContent,
      attributesHtml: 'data-browser-address-target="external" target="_blank" rel="noreferrer"',
    })
    : buttonHtml({ type: "button", variant: "secondary", content: externalLinkContent, disabled: true });
  const backButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>', label: "Back" },
    disabled: true,
  });
  const forwardButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>', label: "Forward" },
    disabled: true,
  });
  const reloadButton = buttonHtml({
    type: "button",
    variant: "secondary",
    content: { kind: "icon-only", iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.5-2.6L20 9M4 15l2.4 2.6A7 7 0 0 0 17.9 15"/></svg>', label: "Reload" },
    attributesHtml: 'data-action="browser-address#reload"',
  });
  const navigation = buttonGroupHtml({
    orientation: "horizontal",
    semantics: "group",
    label: "Browser navigation",
    itemsHtml: `${backButton}${forwardButton}${reloadButton}`,
  });
  return `<turbo-frame id="${browserFrameId(workspaceId, appKey)}" class="browser-frame">
    <div class="browser-shell">
      <form class="browser-toolbar work-view-toolbar" method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/browser/${encodeURIComponent(appKey)}/navigate" data-turbo-frame="${browserFrameId(workspaceId, appKey)}" data-controller="browser-address" data-action="submit->browser-address#submit">
        <div class="browser-window-controls" aria-hidden="true"><span class="red"></span><span class="amber"></span><span class="green"></span></div>
        <div class="browser-navigation">${navigation}</div>
        <input id="${navigationKey}_address" data-turbo-permanent class="browser-address-input text-field" name="url" value="${escapeHtml(view.targetUrl)}" placeholder="http://localhost:3000" spellcheck="false" autocomplete="off" aria-label="Browser URL" data-action="click->browser-address#initializeAddress">
        ${externalLink}
      </form>
      <div class="browser-viewport">
        <iframe id="${navigationKey}_viewport" data-turbo-permanent${frameControllerAttributes} title="Workspace browser preview" loading="lazy" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </turbo-frame>`;
}
