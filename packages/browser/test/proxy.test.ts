import { describe, expect, test } from "bun:test";
import { patchBrowserWorkspaceAppResponse } from "../src/server/proxy.ts";
import { renderBrowserFrame } from "../src/server/render.ts";
import { normalizeBrowserUrl, setWorkspaceBrowserTarget } from "../src/server/state.ts";

describe("browser proxy response patching", () => {
  test("rewrites localhost links and injects the browser bridge", async () => {
    const response = new Response(`<html><head></head><body><a href="http://localhost:3000/page?x=1#top">page</a></body></html>`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "script-src 'self'",
      },
    });

    const patched = await patchBrowserWorkspaceAppResponse(
      { appKey: "browser", workspaceId: "work_1" },
      response,
      new Request("https://browser--work_1.localhost/start"),
    );

    const html = await patched.text();
    expect(html).toContain(`href="https://browser--work_1.localhost/page?x=1#top"`);
    expect(html).toContain("atelier:browser-location");
    expect(patched.headers.has("content-security-policy")).toBe(false);
  });

  test("browser state and iframe source preserve hash fragments", () => {
    expect(normalizeBrowserUrl("localhost:3000/page#section")).toBe("http://localhost:3000/page#section");
    setWorkspaceBrowserTarget("hash_work", "browser", "http://localhost:3000/page?x=1#section");
    expect(renderBrowserFrame("hash_work", "browser")).toContain(`data-workspace-app-frame-initial-path-value="/page?x=1#section"`);
  });
});
