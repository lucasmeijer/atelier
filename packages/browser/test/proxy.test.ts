import { describe, expect, test } from "bun:test";
import { patchBrowserWorkspaceAppRequestHeaders, patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "../src/server/proxy.ts";
import { renderBrowserFrame } from "../src/server/render.ts";
import { createWorkspaceBrowserTab, listWorkspaceBrowserTabs, normalizeBrowserUrl, setWorkspaceBrowserTarget } from "../src/server/state.ts";

interface BrowserApp {
  appKey: string;
  workspaceId: string;
}

function browserApp(workspaceId: string): BrowserApp {
  const tab = createWorkspaceBrowserTab(workspaceId);
  setWorkspaceBrowserTarget(workspaceId, tab.key, "http://localhost:3000/");
  return { appKey: tab.key, workspaceId };
}

describe("browser proxy response patching", () => {
  test("rewrites localhost links and injects the browser bridge", async () => {
    const response = new Response(`<html><head></head><body><a href="http://localhost:3000/page?x=1#top">page</a></body></html>`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "script-src 'self'",
        "x-frame-options": "DENY",
      },
    });

    const patched = await patchBrowserWorkspaceAppResponse(
      browserApp("work_1"),
      response,
      new Request("https://browser--work_1.localhost/start"),
    );

    const html = await patched.text();
    expect(html).toContain(`href="https://browser--work_1.localhost/page?x=1#top"`);
    expect(html).toContain("atelier:browser-location");
    expect(html).toContain("data-atelier-browser-theme");
    expect(patched.headers.has("content-security-policy")).toBe(false);
    expect(patched.headers.has("x-frame-options")).toBe(false);
  });

  test("injects the current Atelier color scheme into preview html", async () => {
    const response = new Response(`<html><head></head><body>Preview</body></html>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const patched = await patchBrowserWorkspaceAppResponse(
      browserApp("theme_work"),
      response,
      new Request("https://browser--theme.localhost/start?atelierColorScheme=light"),
    );

    const html = await patched.text();
    expect(html).toContain("data-atelier-browser-theme");
    expect(html).toContain("color-scheme:light");
  });

  test("external browser targets use the target host header", async () => {
    const tab = createWorkspaceBrowserTab("external_host_work");
    setWorkspaceBrowserTarget("external_host_work", tab.key, "https://example.com/path");
    const headers = new Headers({ host: "127.0.0.1:43000" });

    const patched = await patchBrowserWorkspaceAppRequestHeaders(
      { appKey: tab.key, workspaceId: "external_host_work" },
      headers,
      new URL("https://example.com/path"),
      new Request("https://browser--external.localhost/path"),
    );

    expect(patched.get("host")).toBe("example.com");
  });

  test("browser state and iframe source preserve hash fragments", () => {
    expect(listWorkspaceBrowserTabs("empty_work")).toEqual([]);
    expect(normalizeBrowserUrl("")).toBe("");
    expect(normalizeBrowserUrl("localhost:3000/page#section")).toBe("http://localhost:3000/page#section");
    const tab = createWorkspaceBrowserTab("hash_work");
    expect(renderBrowserFrame("hash_work", tab)).not.toContain("data-controller=\"workspace-app-frame\"");
    setWorkspaceBrowserTarget("hash_work", tab.key, "http://localhost:3000/page?x=1#section");
    expect(renderBrowserFrame("hash_work", tab)).toContain(`data-workspace-app-frame-initial-path-value="/page?x=1#section"`);
  });

  test("does not forward Atelier theme params to the browser target", async () => {
    const tab = createWorkspaceBrowserTab("strip_theme_work");
    setWorkspaceBrowserTarget("strip_theme_work", tab.key, "https://example.com/root");

    const target = await resolveBrowserWorkspaceAppTarget(
      { appKey: tab.key, workspaceId: "strip_theme_work" },
      new URL("/page?x=1&atelierColorScheme=dark#top", "https://browser.localhost"),
    );

    expect(target.toString()).toBe("https://example.com/page?x=1");
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
      browserApp("ports_work"),
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
      browserApp("redirect_work"),
      response,
      new Request("https://browser--redirect.localhost/current"),
    );

    expect(patched.status).toBe(302);
    expect(patched.headers.get("location")).toBe("https://browser--redirect.localhost/next?x=1#top");
    expect(await patched.text()).toBe("redirecting");
  });
});
