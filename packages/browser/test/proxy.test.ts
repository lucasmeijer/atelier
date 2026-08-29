import { describe, expect, test } from "bun:test";
import { nestedWorkspaceProxyRedirectHeader } from "@atelier/proxy-ingress/server";
import { patchBrowserWorkspaceAppResponse, resolveBrowserWorkspaceAppTarget } from "../src/server/proxy.ts";
import { renderBrowserFrame } from "../src/server/render.ts";
import { createWorkspaceBrowserView, deleteWorkspaceBrowserView, listWorkspaceBrowserViews, normalizeBrowserUrl, setWorkspaceBrowserTarget } from "../src/server/state.ts";

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
  test("leaves links declarative and injects the user-navigation bridge", async () => {
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
    expect(html).toContain(`href="http://localhost:3000/page?x=1#top"`);
    expect(html).toContain("atelier:browser-location");
    expect(html).toContain(`addEventListener("click"`);
    expect(html).toContain(`anchor.href = proxy.toString()`);
    expect(html).toContain(`window.open = function`);
    expect(html).toContain(`targetOrigin: "http://localhost:3000"`);
    expect(html).toContain("data-atelier-browser-theme");
    expect(patched.headers.has("content-security-policy")).toBe(false);
    expect(patched.headers.has("x-frame-options")).toBe(false);
  });

  test("injects the preview bridge without waiting for the complete HTML body", async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const patchedPromise = patchBrowserWorkspaceAppResponse(
      browserApp("streaming_work"),
      new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }),
      new Request("https://browser--streaming.localhost/start"),
    );
    source!.enqueue(new TextEncoder().encode("<html><head></head><body>first"));
    const patched = await patchedPromise;
    const reader = patched.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("atelier:browser-location");
    source!.enqueue(new TextEncoder().encode(" second</body></html>"));
    source!.close();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("second");
    await reader.read();
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

  test("loads external sites directly rather than proxying them", () => {
    const view = createWorkspaceBrowserView("external_render_work");
    setWorkspaceBrowserTarget("external_render_work", view.key, "https://example.com/path?x=1#top");
    const html = renderBrowserFrame("external_render_work", view);
    expect(html).toContain(`src="https://example.com/path?x=1#top"`);
    expect(html).not.toContain(`data-controller="workspace-app-frame"`);
  });

  test("never reuses a deleted browser app identity", () => {
    const workspaceId = `identity_${crypto.randomUUID()}`;
    const first = createWorkspaceBrowserView(workspaceId);
    deleteWorkspaceBrowserView(workspaceId, first.key);
    const second = createWorkspaceBrowserView(workspaceId);
    expect(second.key).not.toBe(first.key);
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

  test("does not resolve external targets through workspace ingress", async () => {
    const view = createWorkspaceBrowserView("external_target_work");
    setWorkspaceBrowserTarget("external_target_work", view.key, "https://example.com/root");

    await expect(resolveBrowserWorkspaceAppTarget(
      { appKey: view.key, workspaceId: "external_target_work" },
      new URL("/page?x=1", "https://browser.localhost"),
    )).rejects.toThrow("load directly");
  });

  test("rejects browser app keys that do not belong to a Workspace view", async () => {
    await expect(resolveBrowserWorkspaceAppTarget(
      { appKey: "browser-999", workspaceId: "unknown_browser_work" },
      new URL("/", "https://browser.localhost"),
    )).rejects.toThrow("unknown workspace app: browser-999");
  });

  test("does not expose ports referenced by passive HTML resources", async () => {
    const response = new Response(`<a href="http://localhost:3001/one">one</a><img src="http://127.0.0.1:3010/two.png"><a href="http://localhost:9999/blocked">blocked</a>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const patched = await patchBrowserWorkspaceAppResponse(
      browserApp("ports_work"),
      response,
      new Request("https://browser--ports.localhost/current"),
    );

    const html = await patched.text();
    expect(html).toContain(`href="http://localhost:3001/one"`);
    expect(html).toContain(`src="http://127.0.0.1:3010/two.png"`);
    expect(html).toContain(`href="http://localhost:9999/blocked"`);
  });

  test("lets external redirects leave the workspace preview origin", async () => {
    const result = await patchRedirect("https://lucasmeijer.com/atelier", "http://lucasmeijer.com/atelier/", "https://browser--redirect.localhost/atelier?atelierBrowserOrigin=https%3A%2F%2Flucasmeijer.com", 301);
    expect(result.patched.headers.get("location")).toBe("http://lucasmeijer.com/atelier/");
    expect(result.targetUrl()).toBe("http://lucasmeijer.com/atelier/");
  });

  test("preserves a changed localhost port across redirects", async () => {
    const result = await patchRedirect("http://localhost:3000/start", "http://localhost:3001/next", "https://browser--redirect.localhost/start?atelierBrowserOrigin=http%3A%2F%2Flocalhost%3A3000", 307);
    expect(result.patched.headers.get("location")).toBe("https://browser--redirect.localhost/next?atelierBrowserOrigin=http%3A%2F%2Flocalhost%3A3001");
    expect(result.targetUrl()).toBe("http://localhost:3001/next");
  });

  test("sends cross-host redirects directly to the external site", async () => {
    const result = await patchRedirect("https://example.com/start", "https://login.example.org/session?next=%2Fhome", "https://browser--redirect.localhost/start?atelierBrowserOrigin=https%3A%2F%2Fexample.com&atelierColorScheme=light");
    expect(result.patched.headers.get("location")).toBe("https://login.example.org/session?next=%2Fhome");
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
