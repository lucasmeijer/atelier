import { describe, expect, test } from "bun:test";
import { nestedWorkspaceProxyRedirectHeader } from "@atelier/proxy-ingress/server";
import { patchBrowserWorkspaceAppRequestHeaders, patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "../src/server/proxy.ts";
import { renderBrowserFrame } from "../src/server/render.ts";
import { createWorkspaceBrowserView, listWorkspaceBrowserViews, normalizeBrowserUrl, setWorkspaceBrowserTarget } from "../src/server/state.ts";

interface BrowserApp {
  appKey: string;
  workspaceId: string;
}

function browserApp(workspaceId: string): BrowserApp {
  const view = createWorkspaceBrowserView(workspaceId);
  setWorkspaceBrowserTarget(workspaceId, view.key, "http://localhost:3000/");
  return { appKey: view.key, workspaceId };
}

async function patchRedirect(targetUrl: string, location: string, requestUrl: string, status = 302, body: string | null = null, headers: Record<string, string> = {}) {
  const workspaceId = `redirect_${crypto.randomUUID()}`;
  const view = createWorkspaceBrowserView(workspaceId);
  setWorkspaceBrowserTarget(workspaceId, view.key, targetUrl);
  const response = new Response(body, { status, headers: { location, ...headers } });
  const patched = await patchBrowserWorkspaceAppResponse({ appKey: view.key, workspaceId }, response, new Request(requestUrl));
  return { patched, targetUrl: () => listWorkspaceBrowserViews(workspaceId)[0]!.targetUrl };
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
    expect(html).toContain(`targetOrigin: "http://localhost:3000"`);
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
    const view = createWorkspaceBrowserView("external_host_work");
    setWorkspaceBrowserTarget("external_host_work", view.key, "https://example.com/path");
    const headers = new Headers({ host: "127.0.0.1:43000" });

    const patched = await patchBrowserWorkspaceAppRequestHeaders(
      { appKey: view.key, workspaceId: "external_host_work" },
      headers,
      new URL("https://example.com/path"),
      new Request("https://browser--external.localhost/path"),
    );

    expect(patched.get("host")).toBe("example.com");
  });

  test("browser state and iframe source preserve hash fragments", () => {
    expect(listWorkspaceBrowserViews("empty_work")).toEqual([]);
    expect(normalizeBrowserUrl("")).toBe("");
    expect(normalizeBrowserUrl("localhost:3000/page#section")).toBe("http://localhost:3000/page#section");
    const view = createWorkspaceBrowserView("hash_work");
    expect(renderBrowserFrame("hash_work", view)).not.toContain("data-controller=\"workspace-app-frame\"");
    setWorkspaceBrowserTarget("hash_work", view.key, "http://localhost:3000/page?x=1#section");
    expect(renderBrowserFrame("hash_work", view)).toContain(`data-workspace-app-frame-initial-path-value="/page?x=1&amp;atelierBrowserOrigin=http%3A%2F%2Flocalhost%3A3000#section"`);
  });

  test("does not forward Atelier theme params to the browser target", async () => {
    const view = createWorkspaceBrowserView("strip_theme_work");
    setWorkspaceBrowserTarget("strip_theme_work", view.key, "https://example.com/root");

    const target = await resolveBrowserWorkspaceAppTarget(
      { appKey: view.key, workspaceId: "strip_theme_work" },
      new URL("/page?x=1&atelierColorScheme=dark&atelierBrowserOrigin=https%3A%2F%2Fredirected.example#top", "https://browser.localhost"),
    );

    expect(target.toString()).toBe("https://redirected.example/page?x=1");
  });

  test("rejects browser app keys that do not belong to a Workspace view", async () => {
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

  test("keeps same-host redirects inside the preview proxy", async () => {
    const result = await patchRedirect("https://lucasmeijer.com/atelier", "http://lucasmeijer.com/atelier/", "https://browser--redirect.localhost/atelier?atelierBrowserOrigin=https%3A%2F%2Flucasmeijer.com", 301);
    expect(result.patched.headers.get("location")).toBe("https://browser--redirect.localhost/atelier/?atelierBrowserOrigin=http%3A%2F%2Flucasmeijer.com");
    expect(result.targetUrl()).toBe("http://lucasmeijer.com/atelier/");
  });

  test("preserves a changed localhost port across redirects", async () => {
    const result = await patchRedirect("http://localhost:3000/start", "http://localhost:3001/next", "https://browser--redirect.localhost/start?atelierBrowserOrigin=http%3A%2F%2Flocalhost%3A3000", 307);
    expect(result.patched.headers.get("location")).toBe("https://browser--redirect.localhost/next?atelierBrowserOrigin=http%3A%2F%2Flocalhost%3A3001");
    expect(result.targetUrl()).toBe("http://localhost:3001/next");
  });

  test("keeps cross-host redirects inside the preview proxy and changes the target origin", async () => {
    const result = await patchRedirect("https://example.com/start", "https://login.example.org/session?next=%2Fhome", "https://browser--redirect.localhost/start?atelierBrowserOrigin=https%3A%2F%2Fexample.com&atelierColorScheme=light");
    expect(result.patched.headers.get("location")).toBe("https://browser--redirect.localhost/session?next=%2Fhome&atelierBrowserOrigin=https%3A%2F%2Flogin.example.org&atelierColorScheme=light");
    expect(result.targetUrl()).toBe("https://login.example.org/session?next=%2Fhome");
  });

  test("lets nested Atelier proxy redirects escape to the parent Atelier", async () => {
    const location = "https://parent.example/workspaces/outer/ports/3001/";
    const result = await patchRedirect(
      "http://localhost:3000/",
      location,
      "https://browser--redirect.localhost/workspaces/inner/apps/browser-1/",
      302,
      null,
      { [nestedWorkspaceProxyRedirectHeader]: "1" },
    );

    expect(result.patched.headers.get("location")).toBe(location);
    expect(result.patched.headers.has(nestedWorkspaceProxyRedirectHeader)).toBe(false);
    expect(result.targetUrl()).toBe("http://localhost:3000/");
  });

  test("leaves malformed redirect locations for the browser to handle", async () => {
    const result = await patchRedirect("http://localhost:3000/", "http://[", "https://browser--redirect.localhost/current");
    expect(result.patched.headers.get("location")).toBe("http://[");
  });

  test("rewrites non-html redirect locations without consuming the body", async () => {
    const result = await patchRedirect("http://localhost:3000/", "http://localhost:3000/next?x=1#top", "https://browser--redirect.localhost/current", 302, "redirecting");
    expect(result.patched.status).toBe(302);
    expect(result.patched.headers.get("location")).toBe("https://browser--redirect.localhost/next?x=1&atelierBrowserOrigin=http%3A%2F%2Flocalhost%3A3000#top");
    expect(await result.patched.text()).toBe("redirecting");
  });
});
