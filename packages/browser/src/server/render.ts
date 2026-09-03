import { actionLinkHtml } from "@atelier/design-system/action-link";
import { buttonHtml } from "@atelier/design-system/button";
import { buttonGroupHtml } from "@atelier/design-system/button-group";
import { escapeHtml, type WorkspaceWorkViewPresentation } from "@atelier/shared";
import { browserFrameId, type WorkspaceBrowserView } from "./state.ts";
import { browserProxyUrl } from "../shared.ts";

export function browserWorkViewPresentation(view: WorkspaceBrowserView): WorkspaceWorkViewPresentation {
  return {
    sourceKey: view.key,
    label: view.label,
    reference: { type: "browser", browserId: view.key },
    kind: "resource",
    availability: { phase: "live" },
  };
}

export function renderBrowserWorkViewBody(workspaceId: string, view: WorkspaceBrowserView): string {
  return `<section class="work-view-pane" data-work-view-source="${escapeHtml(view.key)}">${renderBrowserPane(workspaceId, view)}</section>`;
}

function renderBrowserPane(workspaceId: string, view: WorkspaceBrowserView): string {
  return `<div class="browser-pane">
    ${renderBrowserFrame(workspaceId, view)}
  </div>`;
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

export function renderBrowserFrame(workspaceId: string, view: WorkspaceBrowserView): string {
  const target = view.targetUrl ? new URL(view.targetUrl) : undefined;
  const workspaceLocal = target ? isWorkspaceLoopbackHost(target.hostname) : false;
  const proxy = target && workspaceLocal ? browserProxyUrl(target, "http://atelier.browser") : undefined;
  const initialPath = proxy ? `${proxy.pathname}${proxy.search}${proxy.hash}` : "";
  const appKey = view.key;
  const frameControllerAttributes = target && workspaceLocal
    ? ` data-controller="workspace-app-frame" data-workspace-app-frame-workspace-id-value="${escapeHtml(workspaceId)}" data-workspace-app-frame-app-key-value="${escapeHtml(appKey)}" data-workspace-app-frame-initial-path-value="${escapeHtml(initialPath)}" allow="${workspacePreviewPermissions}" allowfullscreen`
    : target ? ` src="${escapeHtml(target.toString())}"` : "";
  const externalLinkContent = {
    kind: "icon-only" as const,
    iconHtml: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6"/></svg>',
    label: "Open preview in a new view",
  };
  const externalLink = target
    ? actionLinkHtml({
      href: target.toString(),
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
        <input class="browser-address-input text-field" name="url" value="${escapeHtml(view.targetUrl)}" placeholder="http://localhost:3000/" spellcheck="false" autocomplete="off" aria-label="Browser URL">
        ${externalLink}
      </form>
      <div class="browser-viewport">
        <iframe${frameControllerAttributes} title="Workspace browser preview" loading="eager" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </turbo-frame>`;
}

function isWorkspaceLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "0.0.0.0";
}
