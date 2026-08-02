#!/usr/bin/env bun

import { resolve } from "node:path";

const port = 4173;
const root = resolve(
  new URL("../apps/web/prototypes/dark-foundation", import.meta.url).pathname,
);
const files = new Map([
  ["/", ["codex-inspired.html", "text/html; charset=utf-8"]],
  ["/index.html", ["codex-inspired.html", "text/html; charset=utf-8"]],
  ["/codex-inspired.html", ["codex-inspired.html", "text/html; charset=utf-8"]],
  ["/quiet-split.html", ["codex-inspired.html", "text/html; charset=utf-8"]],
  ["/studio-desk.html", ["codex-inspired.html", "text/html; charset=utf-8"]],
  [
    "/instrument-panel.html",
    ["codex-inspired.html", "text/html; charset=utf-8"],
  ],
  ["/prototype.js", ["prototype.js", "text/javascript; charset=utf-8"]],
] as const);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const route = files.get(new URL(request.url).pathname);
    if (!route) return new Response("not found", { status: 404 });
    return new Response(Bun.file(resolve(root, route[0])), {
      headers: { "content-type": route[1], "cache-control": "no-store" },
    });
  },
});

console.log(`Codex-inspired Atelier prototype: http://127.0.0.1:${port}`);

await new Promise(() => {});
