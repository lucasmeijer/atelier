import { createHash } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { stripHopByHopHeaders } from "@atelier/shared";
import { HttpRequestBlockedError } from "../secrets/errors.ts";

// Match the HTTP fetch path's environment proxy routing, including nested Atelier.
export type UpgradeRequest = (url: URL, options: RequestOptions) => ClientRequest;
export const requestWebSocketUpgrade: UpgradeRequest = (url, options) => {
  const proxy = getProxyForUrl(url.href);
  // The agent creates its CONNECT socket before ClientRequest owns it. Forward cancellation
  // to net/tls.connect as well as to the request so a stalled proxy cannot retain that socket.
  const agent = proxy ? new HttpsProxyAgent(proxy, { signal: options.signal }) : false;
  return (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { ...options, agent });
};

function tokens(value: string | null): string[] {
  return (value ?? "").split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
}

export function validateWebSocketRequest(request: Request): void {
  const headers = request.headers;
  const key = headers.get("sec-websocket-key") ?? "";
  if (request.method !== "GET" || headers.get("upgrade")?.toLowerCase() !== "websocket"
    || !tokens(headers.get("connection")).includes("upgrade")
    || headers.get("sec-websocket-version") !== "13"
    || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").length !== 16
    || headers.has("transfer-encoding") || (headers.has("content-length") && headers.get("content-length") !== "0")) {
    throw new HttpRequestBlockedError("Invalid WebSocket upgrade request", 400, "Bad Request");
  }
}

function forwardingHeaders(headers: Headers): Headers {
  return stripHopByHopHeaders(headers, [...tokens(headers.get("connection")), "proxy-connection", "host"]);
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
  return headers;
}

function serializeResponse(response: IncomingMessage, headers: Headers): string {
  return `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${[...headers].map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`;
}

/** Preserve the negotiated protocol and raw frames, including masking, compression and control frames. */
export async function bridgeWebSocket(request: Request, client: Duplex, head: Buffer, open: UpgradeRequest): Promise<void> {
  const headers = forwardingHeaders(request.headers);
  headers.set("connection", "Upgrade");
  headers.set("upgrade", "websocket");
  const expectedAccept = createHash("sha1").update(`${request.headers.get("sec-websocket-key")}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  await new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const upstream = open(new URL(request.url), { method: "GET", headers: Object.fromEntries(headers), maxHeaderSize: 16 * 1024, signal: controller.signal });
    let committed = false;
    let cancelled = false;
    const cancel = (error: Error) => {
      if (committed || cancelled) return;
      cancelled = true;
      clearHandshake();
      // Settle independently of ClientRequest events: its agent may still be awaiting CONNECT.
      reject(error);
      controller.abort();
      upstream.destroy();
    };
    // This deadline covers DNS, proxy CONNECT, TLS, and the HTTP handshake, not the WebSocket lifetime.
    const timeout = setTimeout(() => cancel(new Error("WebSocket upstream handshake timed out")), 30_000);
    const abort = () => cancel(new Error("WebSocket client disconnected during handshake"));
    client.once("close", abort);
    client.once("error", abort);
    const clearHandshake = () => {
      clearTimeout(timeout);
      client.off("close", abort);
      client.off("error", abort);
    };
    upstream.once("error", error => {
      if (committed) client.destroy(); else cancel(error);
    });
    upstream.once("close", () => {
      if (!committed) cancel(new Error("WebSocket upstream closed during handshake"));
    });
    upstream.once("response", response => {
      if (cancelled) { response.destroy(); return; }
      committed = true;
      clearHandshake();
      // Forward rejections (including 401, 429 and redirects) without following redirects or exposing credentials elsewhere.
      const outgoing = forwardingHeaders(responseHeaders(response));
      outgoing.set("connection", "close");
      client.write(serializeResponse(response, outgoing));
      response.on("error", () => client.destroy());
      client.once("close", () => response.destroy());
      response.pipe(client);
      resolve();
    });
    upstream.once("upgrade", (response, socket, upstreamHead) => {
      if (cancelled) { socket.destroy(); return; }
      clearHandshake();
      const received = responseHeaders(response);
      if (response.statusCode !== 101 || received.get("upgrade")?.toLowerCase() !== "websocket"
        || !tokens(received.get("connection")).includes("upgrade")
        || received.get("sec-websocket-accept") !== expectedAccept) {
        socket.destroy();
        cancel(new Error("Invalid upstream WebSocket handshake"));
        return;
      }
      committed = true;
      client.on("error", () => socket.destroy());
      socket.on("error", () => client.destroy());
      client.once("close", () => { if (client.readableEnded) socket.end(); else socket.destroy(); });
      socket.once("close", () => { if (socket.readableEnded) client.end(); else client.destroy(); });
      const outgoing = forwardingHeaders(received);
      outgoing.set("connection", "Upgrade");
      outgoing.set("upgrade", "websocket");
      client.write(serializeResponse(response, outgoing));
      // Both parsers can read beyond the headers. These bytes must precede piped traffic.
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
      resolve();
    });
    if (client.destroyed) abort(); else upstream.end();
  });
}
