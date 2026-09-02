import { expect, test } from "bun:test";
import { renderBrowserFrame } from "../src/server/render.ts";
import { createWorkspaceBrowserView, setWorkspaceBrowserTarget } from "../src/server/state.ts";

test("browser navigation uses the shared Button Group interface", () => {
  const workspaceId = `render_${crypto.randomUUID()}`;
  const html = renderBrowserFrame(workspaceId, createWorkspaceBrowserView(workspaceId));
  const navigation = html.slice(html.indexOf('class="browser-navigation'), html.indexOf('class="browser-address-input'));

  expect(navigation).toContain('class="browser-navigation button-group" role="group" aria-label="Browser navigation"');
  expect(navigation.match(/class="browser-nav-button button secondary icon-only"/g)).toHaveLength(3);
  expect(navigation.match(/aria-label="(Back|Forward)" disabled/g)).toHaveLength(2);
  expect(navigation).toContain('data-action="browser-address#reload"');
});

test("workspace previews can request browser capabilities without delegating them to external sites", () => {
  const workspaceId = `render_${crypto.randomUUID()}`;
  const view = createWorkspaceBrowserView(workspaceId);

  setWorkspaceBrowserTarget(workspaceId, view.key, "http://localhost:3000/");
  const workspacePreview = renderBrowserFrame(workspaceId, view);
  expect(workspacePreview).toContain('allow="clipboard-write; camera; microphone; geolocation; display-capture; fullscreen; autoplay; picture-in-picture; web-share; payment; usb; serial; hid; bluetooth; midi; gamepad; accelerometer; gyroscope; magnetometer; xr-spatial-tracking"');
  expect(workspacePreview).toContain("allowfullscreen");
  expect(workspacePreview).not.toContain("clipboard-read");

  setWorkspaceBrowserTarget(workspaceId, view.key, "https://example.com/");
  expect(renderBrowserFrame(workspaceId, view)).not.toContain(" allow=");
});
