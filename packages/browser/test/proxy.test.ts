import { describe, expect, test } from "bun:test";
import { patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "../src/server/proxy.ts";
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
    expect(normalizeBrowserUrl("")).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("localhost:3000/page#section")).toBe("http://localhost:3000/page#section");
    setWorkspaceBrowserTarget("hash_work", "browser", "http://localhost:3000/page?x=1#section");
    expect(renderBrowserFrame("hash_work", "browser")).toContain(`data-workspace-app-frame-initial-path-value="/page?x=1#section"`);
  });

  test("rejects browser app keys that do not belong to a workspace tab", async () => {
    await expect(resolveBrowserWorkspaceAppTarget(
      { appKey: "browser-999", workspaceId: "unknown_browser_work" },
      new URL("/", "https://browser.localhost"),
    )).rejects.toThrow("unknown workspace app: browser-999");
  });

  test("rewrites supported localhost preview ports in html", async () => {
    const response = new Response(`<a href="http://localhost:3001/one">one</a><img src="http://127.0.0.1:3010/two.png"><a href="http://localhost:9999/blocked">blocked</a>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const patched = await patchBrowserWorkspaceAppResponse(
      { appKey: "browser", workspaceId: "ports_work" },
      response,
      new Request("https://browser--ports.localhost/current"),
    );

    const html = await patched.text();
    expect(html).toContain(`href="https://browser--ports.localhost/one"`);
    expect(html).toContain(`src="https://browser--ports.localhost/two.png"`);
    expect(html).toContain(`href="http://localhost:9999/blocked"`);
  });

  test("rewrites non-html redirect locations without consuming the body", async () => {
    const response = new Response("redirecting", {
      status: 302,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        location: "http://localhost:3000/next?x=1#top",
      },
    });

    const patched = await patchBrowserWorkspaceAppResponse(
      { appKey: "browser", workspaceId: "redirect_work" },
      response,
      new Request("https://browser--redirect.localhost/current"),
    );

    expect(patched.status).toBe(302);
    expect(patched.headers.get("location")).toBe("https://browser--redirect.localhost/next?x=1#top");
    expect(await patched.text()).toBe("redirecting");
  });
});
