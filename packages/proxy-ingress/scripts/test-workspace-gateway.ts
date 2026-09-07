// Non-UI protocol integration: real Bun ingress -> compiled Go gateway -> local app.
// Run with `bun run test:gateway` (requires Go 1.26+).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkspaceIngress } from "../src/ingress/index.ts";

async function run(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const process = Bun.spawn(command, { ...options, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  assert.equal(await process.exited, 0, command.join(" "));
}

async function exerciseIngress(gatewayUrl: string, token: string) {
  let appRequests = 0;
  let streamCancelled!: () => void;
  const cancelled = new Promise<void>(resolve => { streamCancelled = resolve; });
  const app = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      appRequests += 1;
      for (const name of ["x-atelier-gateway-host", "x-atelier-gateway-token", "x-atelier-gateway-port", "x-atelier-gateway-protocol", "proxy-authorization"]) assert.equal(request.headers.get(name), null, `credential/metadata leaked: ${name}`);
      assert.equal(request.headers.get("host"), request.headers.get("x-forwarded-host"));
      assert.equal(request.headers.get("x-atelier-parent-workspace"), "integration");
      const url = new URL(request.url);
      if (url.pathname === "/socket") {
        assert.equal(request.headers.get("cookie"), "session=app");
        assert.equal(request.headers.get("authorization"), "Bearer app-token");
        if (server.upgrade(request, { headers: { "sec-websocket-protocol": "echo" } })) return;
        throw new Error("WebSocket upgrade failed");
      }
      if (url.pathname === "/events") return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: ready\n\n")); },
        cancel() { streamCancelled(); },
      }), { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/app-error") return new Response("application failure", { status: 502, headers: { "x-atelier-gateway-error": "upstream" } });
      if (url.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://localhost:5173/next", "set-cookie": "session=ok; HttpOnly" } });
      if (request.method === "POST") return new Response(await request.text());
      return new Response(`${url.pathname}${url.search}`);
    },
    websocket: { message(socket, message) { socket.send(message); } },
  });
  let targetPort = app.port!;
  let delayedApp: ReturnType<typeof Bun.serve> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const originPort = probe.port!;
  probe.stop(true);
  const ingress = createWorkspaceIngress({
    hostname: "127.0.0.1",
    originPortRange: { start: originPort, end: originPort },
    resolveWorkspace: () => undefined,
    resolveApp: (_app, url) => ({ kind: "http", target: new URL(`http://127.0.0.1:${targetPort}${url.pathname}${url.search}`), gateway: { url: new URL(gatewayUrl), token } }),
  });
  const request = (url: string, init: BunFetchRequestInit = {}) => fetch(url, { proxy: new URL(url).origin, signal: AbortSignal.timeout(5000), ...init });
  try {
    await ingress.initialize();
    const opened = await ingress.openCanonical({ workspaceId: "integration", appKey: "web" }, "/", new Request("http://127.0.0.1:3000/"));
    assert.equal(opened.status, 302);
    const origin = new URL(opened.headers.get("location")!).origin;
    assert.equal(await (await request(`${origin}/a%2Fb?x=%2F`)).text(), "/a%2Fb?x=%2F");
    const payload = "large streamed upload\n".repeat(100000);
    const encoder = new TextEncoder();
    const upload = new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(encoder.encode(payload.slice(0,1000)));
      await Bun.sleep(20);
      controller.enqueue(encoder.encode(payload.slice(1000)));
      controller.close();
    }});
    assert.equal(await (await request(`${origin}/echo`, { method: "POST", body: upload, headers: { "x-atelier-gateway-token": "forged", "x-atelier-gateway-port": "22" } })).text(), payload);
    const redirect = await request(`${origin}/redirect`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "http://localhost:5173/next");
    assert.equal(redirect.headers.get("set-cookie"), "session=ok; HttpOnly");
    await redirect.text();
    const stream = await request(`${origin}/events`);
    const reader = stream.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "data: ready\n\n");
    await reader.cancel();
    await Promise.race([cancelled, Bun.sleep(4000).then(() => { throw new Error("stream cancellation did not reach app"); })]);
    // SAFETY: Bun supports this options constructor; the DOM declaration omits it.
    const Socket = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
    const socket = new Socket(`${origin.replace("http:", "ws:")}/socket`, { proxy: "", protocols: ["echo"], headers: { cookie: "session=app", authorization: "Bearer app-token" } });
    socket.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("WebSocket timeout")); }, 4000);
      let messages = 0;
      socket.addEventListener("open", () => { assert.equal(socket.protocol, "echo"); socket.send("text"); });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket failed")); });
      socket.addEventListener("message", event => {
        try {
          if (messages++ === 0) { assert.equal(event.data, "text"); socket.send(new Uint8Array([0, 128, 255])); }
          else { assert.deepEqual(new Uint8Array(event.data), new Uint8Array([0, 128, 255])); socket.close(4001, "done"); }
        } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
      });
      socket.addEventListener("close", event => {
        clearTimeout(timer);
        try { assert.equal(messages, 2); assert.equal(event.code, 4001); assert.equal(event.reason, "done"); resolve(); } catch (error) { reject(error); }
      });
    });
    assert.equal(appRequests, 5);
    const denied = await request(gatewayUrl, { headers: { "x-atelier-gateway-port": String(app.port), "x-atelier-gateway-protocol": "http" } });
    assert.equal(denied.status, 401);
    await denied.text();
    assert.equal(appRequests, 5, "unauthenticated caller reached the app");
    const rawPath = "/query?value=a;b&z=%ZZ&keep=yes&x=a%20b&x=a+b";
    assert.equal(await (await request(origin + rawPath)).text(), rawPath);
    const beforeAppError = appRequests;
    const appError = await request(`${origin}/app-error`);
    assert.equal(appError.status, 502);
    assert.equal(await appError.text(), "application failure");
    assert.equal(appError.headers.get("x-atelier-gateway-error"), null);
    assert.equal(appRequests, beforeAppError + 1, "ordinary app 502 was retried");

    const unused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    targetPort = unused.port!;
    unused.stop(true);
    const unavailable = await request(origin);
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /connection refused/i);
    assert.equal(unavailable.headers.get("x-atelier-gateway-error"), null);
    assert.equal(ingress.inspect()[0]!.targetState, "failed");
    assert.equal(ingress.inspect()[0]!.failureCategory, "connection_refused");

    startupTimer = setTimeout(() => {
      delayedApp = Bun.serve({ hostname: "127.0.0.1", port: targetPort, fetch: () => new Response("started") });
    }, 50);
    const recovered = await request(origin);
    assert.equal(recovered.status, 200);
    assert.equal(await recovered.text(), "started");
    assert.equal(ingress.inspect()[0]!.targetState, "active");
    assert.equal(ingress.inspect()[0]!.lastFailure, undefined);
    console.log("PASS: raw queries, app 502 isolation, gateway failure reporting, startup retry and recovery");
    console.log(`PASS: real ingress + Go gateway, app port ${app.port}, NO_PROXY=${JSON.stringify(process.env.NO_PROXY)}; HTTP, streamed upload, SSE/cancellation, redirects/cookies, text/binary WebSockets, auth, and header isolation`);
  } finally {
    await ingress.stopAll();
    clearTimeout(startupTimer);
    delayedApp?.stop(true);
    app.stop(true);
  }
}

if (process.argv[2] === "--client") {
  await exerciseIngress(process.argv[3]!, process.argv[4]!);
} else {
  const source = resolve(import.meta.dir, "../../workspace-image/workspace-image/gateway");
  const directory = await mkdtemp(join(tmpdir(), "atelier-gateway-test-"));
  const binary = join(directory, "gateway");
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenFile = join(directory, "token");
  const readyFile = join(directory, "ready");
  await writeFile(tokenFile, token, { mode: 0o600 });
  let gateway: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await run(["go", "test", "-race", "./..."], { cwd: source });
    await run(["go", "build", "-o", binary, "."], { cwd: source });
    for (const noProxy of ["*", ""]) {
      gateway = Bun.spawn([binary, "-listen", "127.0.0.1:0", "-token-file", tokenFile, "-ready-file", readyFile], {
        stdout: "inherit", stderr: "inherit", stdin: "ignore",
        env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", NO_PROXY: noProxy },
      });
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(readyFile).exists())) {
        assert.equal(gateway.exitCode, null, "gateway failed to start");
        assert.ok(Date.now() < deadline, "gateway readiness timed out");
        await Bun.sleep(20);
      }
      const gatewayUrl = `http://${(await Bun.file(readyFile).text()).trim()}`;
      await run(["bun", import.meta.path, "--client", gatewayUrl, token], {
        env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", http_proxy: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1", NO_PROXY: noProxy, no_proxy: noProxy },
      });
      gateway.kill("SIGTERM");
      assert.equal(await gateway.exited, 0);
      await rm(readyFile);
      await assert.rejects(fetch(gatewayUrl, { proxy: "", signal: AbortSignal.timeout(1000) }));
      console.log("PASS: gateway terminates cleanly and closes its listener");
    }
  } finally {
    if (gateway && gateway.exitCode === null) { gateway.kill(); await gateway.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}
