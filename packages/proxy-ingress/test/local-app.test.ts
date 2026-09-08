import { describe, expect, test } from "bun:test";
import type { WorkspaceHttpAppBackend } from "@atelier/shared";
import { adaptLocalAppResponse, isSameLocalApp, localAppHost, translateLocalAppOrigin } from "../src/ingress/local-app.ts";
import { createWorkspaceIngress } from "../src/ingress/index.ts";

const backend: WorkspaceHttpAppBackend = { kind: "http", target: new URL("http://127.0.0.1:5173/current") };

function patch(location: string, app = backend): Response {
  return adaptLocalAppResponse(app, new Response("redirect", { status: 307, headers: { location } }), "https://preview.example:41000");
}

describe("local app compatibility", () => {
  test.each([
    ["http://localhost:5173/next?q=a%20b#top", "https://preview.example:41000/next?q=a%20b#top"],
    ["http://127.0.0.1:5173/next", "https://preview.example:41000/next"],
    ["http://[::1]:5173/next", "https://preview.example:41000/next"],
    ["//localhost:5173/next", "https://preview.example:41000/next"],
    ["../next", "https://preview.example:41000/next"],
    ["http://localhost:5173//other.example/path", "https://preview.example:41000//other.example/path"],
  ])("rewrites only the current app redirect %s", async (location, expected) => {
    const response = patch(location);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(expected);
    expect(await response.text()).toBe("redirect");
  });

  test.each([
    "http://localhost:8080/next", "https://localhost:5173/next", "http://localhost/next",
    "https://login.example/next", "//other.example/path", "http://[", "javascript:alert(1)",
    "http://localhost.evil:5173/", "http://user:password@localhost:5173/",
  ])("does not publish or rewrite unrelated destination %s", (location) => {
    expect(patch(location).headers.get("location")).toBe(location);
  });

  test("uses effective default ports and HTTP/HTTPS origins", () => {
    expect(localAppHost(new URL("http://127.0.0.1/"))).toBe("localhost:80");
    expect(localAppHost(new URL("https://127.0.0.1/"))).toBe("localhost:443");
    expect(isSameLocalApp(new URL("https://127.0.0.1/"), new URL("https://localhost:443/"))).toBe(true);
    expect(isSameLocalApp(new URL("https://127.0.0.1/"), new URL("http://localhost:443/"))).toBe(false);
  });

  test("makes explicitly local cookies host-only without combining cookies or weakening attributes", () => {
    const headers = new Headers();
    for (const cookie of [
      "session=secret; Domain=.LOCALHOST; Path=/; HttpOnly; Secure; SameSite=Strict",
      "other=x; domain=127.0.0.1; Expires=Wed, 21 Oct 2030 07:28:00 GMT",
      "external=x; Domain=example.com; Path=/",
      "hostonly=x; HttpOnly",
    ]) headers.append("set-cookie", cookie);
    const response = adaptLocalAppResponse(backend, new Response(null, { headers }), "https://preview.example");
    expect(response.headers.getSetCookie()).toEqual([
      "session=secret; Path=/; HttpOnly; Secure; SameSite=Strict",
      "other=x; Expires=Wed, 21 Oct 2030 07:28:00 GMT",
      "external=x; Domain=example.com; Path=/",
      "hostonly=x; HttpOnly",
    ]);
  });

  test.each([
    ["https://preview.example:41000", "http://localhost:5173"],
    ["http://preview.example:41000", "http://preview.example:41000"],
    ["https://preview.example:41001", "https://preview.example:41001"],
    ["https://preview.example", "https://preview.example"],
    ["https://preview.example:41000.evil", "https://preview.example:41000.evil"],
    ["https://preview.example:41000/", "https://preview.example:41000/"],
    ["https://preview.example:41000 https://evil.example", "https://preview.example:41000 https://evil.example"],
    ["null", "null"],
    [null, null],
  ])("translates only an exact serialized origin match (%s)", (origin, expected) => {
    const headers = new Headers(origin === null ? {} : { origin });
    const translation = translateLocalAppOrigin(backend, headers, "https://preview.example:41000");
    expect(headers.get("origin")).toBe(expected);
    expect(Boolean(translation)).toBe(origin === "https://preview.example:41000");
  });

  test("uses serialized HTTP and HTTPS default-port origins", () => {
    for (const protocol of ["http:", "https:"]) {
      const headers = new Headers({ origin: "https://preview.example" });
      const app = { ...backend, target: new URL(`${protocol}//127.0.0.1/`) };
      translateLocalAppOrigin(app, headers, "https://preview.example");
      expect(headers.get("origin")).toBe(`${protocol}//localhost`);
    }
  });

  test("reverses CORS and timing origins only for requests actually translated", () => {
    const translation = { receiving: "https://preview.example:41000", upstream: "http://localhost:5173" };
    for (const translated of [translation, undefined]) {
      const response = adaptLocalAppResponse(backend, new Response(null, { headers: {
        "access-control-allow-origin": translation.upstream,
        "timing-allow-origin": `https://metrics.example, ${translation.upstream}`,
        "access-control-allow-credentials": "true", "access-control-allow-methods": "POST",
        "access-control-allow-headers": "X-App", vary: "Accept-Encoding",
      } }), translation.receiving, translated);
      expect(response.headers.get("access-control-allow-origin")).toBe(translated ? translation.receiving : translation.upstream);
      expect(response.headers.get("timing-allow-origin")).toBe(`https://metrics.example, ${translated ? translation.receiving : translation.upstream}`);
      expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin");
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-allow-methods")).toBe("POST");
      expect(response.headers.get("access-control-allow-headers")).toBe("X-App");
    }
    for (const value of ["*", "null", "https://other.example", "http://localhost:8080"]) {
      const response = adaptLocalAppResponse(backend, new Response(null, { headers: { "access-control-allow-origin": value, vary: "*" } }), translation.receiving, translation);
      expect(response.headers.get("access-control-allow-origin")).toBe(value);
      expect(response.headers.get("vary")).toBe("*");
    }
  });

  test.each(["same-origin", "https://attacker.example", "null", "missing"])("HTTP and WebSocket translate only same-origin requests (%s)", async (requestOrigin) => {
    const observed: Headers[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        observed.push(new Headers(request.headers));
        if (request.headers.get("upgrade") === "websocket") {
          if (server.upgrade(request)) return;
          throw new Error("upgrade failed");
        }
        return new Response("ok");
      },
      websocket: { message(socket, message) { socket.send(message); } },
    });
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port!;
    probe.stop(true);
    const ingress = createWorkspaceIngress({
      hostname: "127.0.0.1", originPortRange: { start: port, end: port },
      resolveWorkspace: () => undefined,
      resolveApp: (_app, url) => ({ kind: "http", target: new URL(`http://127.0.0.1:${upstream.port}${url.pathname}${url.search}`) }),
    });
    const publicOrigin = `https://preview.example:${port}`;
    const originHeader = requestOrigin === "same-origin" ? publicOrigin : requestOrigin === "missing" ? null : requestOrigin;
    const headers = new Headers({ host: `preview.example:${port}`, "x-forwarded-proto": "https", "x-atelier-public-origin": "https://spoofed.example", forwarded: "host=spoofed.example;proto=https", referer: "https://attacker.example/form", cookie: "session=ok", authorization: "Bearer app-token" });
    if (originHeader !== null) headers.set("origin", originHeader);
    try {
      await ingress.initialize();
      await ingress.openCanonical({ workspaceId: "test", appKey: "app" }, "/", new Request("https://preview.example:3000/"));
      const origin = `http://127.0.0.1:${port}`;
      expect(await (await fetch(origin, { method: "POST", body: "payload", headers })).text()).toBe("ok");
      // SAFETY: Bun exposes an options constructor absent from the DOM declaration.
      const Socket = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
      const socket = new Socket(origin.replace("http:", "ws:"), { headers: Object.fromEntries(headers), proxy: "" });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket timed out")); }, 4000);
        socket.addEventListener("open", () => socket.send("hot-reload"));
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket failed")); });
        socket.addEventListener("message", (event) => {
          expect(event.data).toBe("hot-reload");
          clearTimeout(timer); socket.close(); resolve();
        });
      });
      expect(observed).toHaveLength(2);
      for (const request of observed) {
        expect(request.get("host")).toBe(`localhost:${upstream.port}`);
        expect(request.get("x-forwarded-host")).toBe(`localhost:${upstream.port}`);
        expect(request.get("x-atelier-public-origin")).toBe(publicOrigin);
        expect(request.get("forwarded")).toBeNull();
        expect(request.get("x-forwarded-proto")).toBe("http");
        expect(request.get("x-forwarded-port")).toBe(String(upstream.port));
        expect(request.get("origin")).toBe(requestOrigin === "same-origin" ? `http://localhost:${upstream.port}` : originHeader);
        expect(request.get("referer")).toBe(headers.get("referer"));
        expect(request.get("cookie")).toBe(headers.get("cookie"));
        expect(request.get("authorization")).toBe(headers.get("authorization"));
      }
    } finally {
      await ingress.stopAll();
      upstream.stop(true);
    }
  });
});
