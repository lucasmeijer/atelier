import { expect, test } from "bun:test";
import { renderBrowserFrame } from "../src/server/render.ts";
import { createWorkspaceBrowserView, setWorkspaceBrowserTarget } from "../src/server/state.ts";

test("workspace previews delegate browser capabilities to their dynamically assigned cross-origin source", () => {
  const workspaceId = `render_${crypto.randomUUID()}`;
  const view = createWorkspaceBrowserView(workspaceId);

  setWorkspaceBrowserTarget(workspaceId, view.key, "http://localhost:3000/");
  const workspacePreview = renderBrowserFrame(workspaceId, view);
  expect(workspacePreview).toContain('allow="clipboard-write *; camera *; microphone *; geolocation *; display-capture *; fullscreen *; autoplay *; picture-in-picture *; web-share *; payment *; usb *; serial *; hid *; bluetooth *; midi *; gamepad *; accelerometer *; gyroscope *; magnetometer *; xr-spatial-tracking *"');
  expect(workspacePreview).toContain("allowfullscreen");
  expect(workspacePreview).not.toContain("clipboard-read");

  setWorkspaceBrowserTarget(workspaceId, view.key, "https://example.com/");
  expect(renderBrowserFrame(workspaceId, view)).not.toContain(" allow=");
});
