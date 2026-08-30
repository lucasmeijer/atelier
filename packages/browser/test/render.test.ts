import { expect, test } from "bun:test";
import { renderBrowserFrame } from "../src/server/render.ts";
import { createWorkspaceBrowserView } from "../src/server/state.ts";

test("browser navigation uses the shared Button Group interface", () => {
  const workspaceId = `render_${crypto.randomUUID()}`;
  const html = renderBrowserFrame(workspaceId, createWorkspaceBrowserView(workspaceId));
  const navigation = html.slice(html.indexOf('class="browser-navigation'), html.indexOf('class="browser-address-input'));

  expect(navigation).toContain('class="browser-navigation button-group" role="group" aria-label="Browser navigation"');
  expect(navigation.match(/class="browser-nav-button button secondary icon-only"/g)).toHaveLength(3);
  expect(navigation.match(/aria-label="(Back|Forward)" disabled/g)).toHaveLength(2);
  expect(navigation).toContain('data-action="browser-address#reload"');
});
