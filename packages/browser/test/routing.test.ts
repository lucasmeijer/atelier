import { describe, expect, test } from "bun:test";
import { browserProxyUrl, browserRequestTarget } from "../src/shared.ts";

const outer = { key: "browser-outer", targetUrl: "http://localhost:3000/" };
const inner = { key: "browser-inner", targetUrl: "http://localhost:5173/" };

describe("browser routing ownership", () => {
  test("an inner canonical request reaches Atelier, not the inner app port", () => {
    const innerUrl = browserProxyUrl(inner.key, new URL(inner.targetUrl), "https://outer-preview.example");
    innerUrl.pathname = "/workspaces/inner/apps/browser-inner/";
    const forwarded = browserRequestTarget(outer, innerUrl);
    expect(forwarded.origin).toBe("http://localhost:3000");
    expect(forwarded.pathname).toBe(innerUrl.pathname);
    expect(forwarded.search).toBe(innerUrl.search);
    expect(browserRequestTarget(inner, forwarded).origin).toBe("http://localhost:5173");
  });

  test("unowned queries pass through without re-encoding", () => {
    const request = new URL("https://preview.example/page?q=a%20b&raw=one;two&atelierBrowserOrigin.browser-inner=http%3A%2F%2Flocalhost%3A5173");
    expect(browserRequestTarget(outer, request).search).toBe(request.search);
  });

  test("each hop removes only its own metadata, preserving app query parameters", () => {
    const target = new URL("http://localhost:5173/page?tag=a&tag=b&next=%2Fhome&atelierBrowserOrigin=app-data#section");
    const innerUrl = browserProxyUrl(inner.key, target, "http://localhost:3000");
    const outerUrl = browserProxyUrl(outer.key, innerUrl, "https://outer-preview.example");
    expect(outerUrl.hash).toBe("#section");
    const forwarded = browserRequestTarget(outer, outerUrl);
    expect(forwarded.origin).toBe(innerUrl.origin);
    expect(forwarded.search).toBe(innerUrl.search);
    const resolved = browserRequestTarget(inner, forwarded);
    target.hash = ""; // Fragments are browser-local, not part of the upstream request.
    expect(resolved.toString()).toBe(target.toString());
  });

  test("redirect URLs retain their own origin even after the view navigates elsewhere", () => {
    const redirected = new URL("http://localhost:8080/next?x=1#top");
    const location = browserProxyUrl(inner.key, redirected, "https://inner-preview.example");
    const resolved = browserRequestTarget({ ...inner, targetUrl: "http://localhost:9000/" }, location);
    expect(resolved.toString()).toBe("http://localhost:8080/next?x=1");
    expect(location.hash).toBe("#top");
  });

  test.each(["not a URL", "file:///etc/passwd"])("invalid owned origin %s uses the configured target", (value) => {
    const request = new URL("https://preview.example/page?x=1");
    request.searchParams.set(`atelierBrowserOrigin.${inner.key}`, value);
    expect(browserRequestTarget(inner, request).toString()).toBe("http://localhost:5173/page?x=1");
  });
});
