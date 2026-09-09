import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryRelay } from "./registry-relay.ts";

test("registry relay streams Docker layer uploads larger than Bun's default body limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "registry-relay-"));
  const socket = join(directory, "registry.sock");
  const size = 129 * 1024 * 1024;
  let received = 0;
  const registry = Bun.serve({ unix: socket, maxRequestBodySize: Number.MAX_SAFE_INTEGER, async fetch(request) {
    expect(request.method).toBe("PUT");
    expect(new URL(request.url).pathname).toBe("/v2/image/blobs/uploads/layer");
    expect(request.headers.get("content-length")).toBe(String(size));
    for await (const chunk of request.body!) received += chunk.byteLength;
    return new Response(null, { status: 201, headers: { location: "/v2/image/blobs/layer" } });
  } });
  const relay = createRegistryRelay(socket);
  try {
    let remaining = size;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (remaining === 0) { controller.close(); return; }
      controller.enqueue(chunk);
      remaining -= chunk.byteLength;
    } });
    const response = await fetch(`http://127.0.0.1:${relay.port}/v2/image/blobs/uploads/layer`, {
      method: "PUT", headers: { "content-length": String(size) }, body,
    });
    await response.arrayBuffer();
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/v2/image/blobs/layer");
    expect(received).toBe(size);
  } finally {
    await relay.stop(true);
    await registry.stop(true);
    await rm(directory, { recursive: true });
  }
}, 30_000);
